// mdast attachment: turn an mdast tree into the same content-block list the
// string core's `parseDocument` produces, but segmented by the CommonMark block
// tree (SPEC.md §5.2) instead of by blank lines. This is the only genuinely new
// logic in the adapter; everything downstream (lint, hash, diff, resolve) reuses
// the core's pure functions over these blocks.
//
// Node -> block mapping is §5.1 for free: a `list`, `code` fence, `blockquote`,
// or `table` is a single mdast node, so a trailing marker binds the whole
// construct regardless of internal blank lines. A marker-shaped comment *inside*
// a fence is part of the `code` node's literal `value`, not a separate `html`
// node, so it is correctly NOT treated as a marker (the intended §5.2 divergence
// from the raw-scan string core).

import { visit } from "unist-util-visit";
// asciiTrim is the core's single ASCII-whitespace trim (SPEC.md §5/§8); importing
// it (rather than re-deriving) keeps the block `content` byte-identical to the
// string core's `asciiTrim(stripMarkers(chunk))`.
import { findMarkers, stripMarkers, asciiTrim } from "markstay";
import { frontmatterSpan } from "./frontmatter.js";

const span = (node) => [node.position.start.offset, node.position.end.offset];

// CRLF / lone CR -> LF, matching the string core's whole-document normalization
// (parseDocument). The mdast offsets index the original (possibly CRLF) source,
// so the slice is converted afterwards to keep `content` byte-identical.
const toLF = (s) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

// Two top-level nodes are in the same blank-line "chunk" when no fully blank line
// separates them, i.e. the next node starts on the line right after the previous
// node ends. A gap of >= 2 lines means at least one blank line between them.
const BLANK_GAP = 2;

// ASCII whitespace incl. newlines, the core's `asciiTrim` set (SPEC.md §5/§8).
const ASCII_WS = /[ \t\n\r\f\v]/;

/** Slice [start, end) of source with the given absolute spans cut out. */
function sliceCut(source, start, end, spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = "";
  let cur = start;
  for (const [s, e] of sorted) {
    if (s > cur) out += source.slice(cur, s);
    cur = Math.max(cur, e);
  }
  out += source.slice(cur, end);
  return out;
}

/**
 * Core markers found in `text`, each paired with its absolute source offset
 * (`baseOffset` + the match's index within `text`). Used for raw-text nodes
 * (`html` blocks) whose markers live in the node's value string rather than as
 * child nodes.
 */
function markersWithOffsets(text, baseOffset, lineOffset) {
  const out = [];
  let cursor = 0;
  for (const mk of findMarkers(text, lineOffset)) {
    const idx = text.indexOf(mk.raw, cursor);
    cursor = idx + mk.raw.length;
    out.push({ mk, off: baseOffset + (idx < 0 ? 0 : idx) });
  }
  return out;
}

/**
 * Markers carried as inline child nodes of a content block (e.g. a trailing
 * `<!-- stay:x -->` that mdast represents as the paragraph's last `html` child,
 * or an `mdxTextExpression`). The container node itself is skipped. A
 * marker-shaped comment inside an `inlineCode`/`code` descendant is literal text,
 * not a child marker node, so it is correctly ignored. Returns [{ mk, off, span }].
 */
function inlineMarkerEntries(node, mdx) {
  const out = [];
  visit(node, (n) => {
    if (n === node || !n.position) return;
    if (n.type === "html") {
      for (const mk of findMarkers(n.value, n.position.start.line - 1)) {
        out.push({ mk, off: n.position.start.offset, span: span(n) });
      }
    } else if (mdx && (n.type === "mdxFlowExpression" || n.type === "mdxTextExpression")) {
      for (const mk of findMarkers(`{${n.value}}`, n.position.start.line - 1)) {
        out.push({ mk, off: n.position.start.offset, span: span(n) });
      }
    }
  });
  return out;
}

/**
 * The line a clamped node's surviving content actually starts on: the frontmatter
 * ends at `fm.endOffset`, but the content after it need not begin on the very next
 * line. A fenced code block opened inside the payload swallows the closing fence and
 * runs past a blank line (fences do not end at blank lines), so the first surviving
 * character can be lines later. The string core reports the first NON-BLANK line, so
 * count the line endings skipped getting there.
 */
function clampedStartLine(source, fm, node) {
  const end = node.position.end.offset;
  let off = fm.endOffset;
  while (off < end && ASCII_WS.test(source[off])) off++;
  const breaks = source.slice(fm.endOffset, off).match(/\r\n|\r|\n/g);
  return fm.endLine + 1 + (breaks ? breaks.length : 0);
}

/**
 * Classify a top-level node into { node, markerOnly, content, entries }, where
 * `entries` are [{ mk, off }] in source order and `markerOnly` is true when the
 * node is nothing but marker(s) (so it attaches to a neighbour rather than being
 * its own block). The four cases mirror the string core's per-chunk logic:
 *
 *  - `code` fence: literal text. No marker detection (marker-in-fence is ignored,
 *    the intended §5.2 divergence); content is the raw slice.
 *  - `html` block: raw text whose embedded `<!-- stay:... -->` comments ARE real
 *    markers (raw-scan, like the string core). A `<div>...</div>` that also holds
 *    a marker is a CONTENT block carrying that marker, not an orphan.
 *  - `mdxFlowExpression`: a whole `{...}` expression; a stay marker makes it
 *    marker-only, anything else is inert content.
 *  - everything else (paragraph, heading, list, blockquote, table, ...): markers
 *    are inline child nodes, cut by node identity so marker-shaped text inside an
 *    inline-code descendant is left in the body.
 */
function classify(node, source, mdx, clamp = null) {
  const [s0, e] = span(node);
  // `clamp` is set only for a node that straddles the end of a leading frontmatter
  // span (see extractBlocks): the metadata half is cut off here so the block body
  // and its line number match what the string core produces on the blanked source.
  const s = clamp ? Math.max(s0, clamp.offset) : s0;
  const startLine = clamp ? clamp.line : node.position.start.line;
  const raw = source.slice(s, e);

  if (node.type === "code" || node.type === "inlineCode") {
    return { node, startLine, markerOnly: false, content: asciiTrim(toLF(raw)), entries: [] };
  }

  if (node.type === "html") {
    const entries = markersWithOffsets(raw, s, startLine - 1);
    const content = asciiTrim(toLF(stripMarkers(raw)));
    return { node, startLine, markerOnly: content === "" && entries.length > 0, content, entries };
  }

  if (mdx && (node.type === "mdxFlowExpression" || node.type === "mdxTextExpression")) {
    const ms = findMarkers(`{${node.value}}`, startLine - 1);
    if (ms.length) return { node, startLine, markerOnly: true, content: "", entries: ms.map((mk) => ({ mk, off: s })) };
    return { node, startLine, markerOnly: false, content: asciiTrim(toLF(raw)), entries: [] };
  }

  const inline = inlineMarkerEntries(node, mdx).filter((x) => x.off >= s);
  const content = asciiTrim(toLF(sliceCut(source, s, e, inline.map((x) => x.span))));
  return { node, startLine, markerOnly: false, content, entries: inline.map((x) => ({ mk: x.mk, off: x.off })) };
}

/**
 * Segment an mdast tree into content blocks with attached markers (SPEC.md §5.2
 * tree attachment). `source` is the original Markdown the tree was parsed from;
 * its offsets drive source-slice body extraction (§8), so pass the exact string
 * given to the parser.
 *
 * Returns block objects shaped like the string core's `parseDocument` output, so
 * the core's `lintBlocks` / `lintDiffBlocks` / anchor + resolve functions consume
 * them unchanged:
 *   { content, markers: [coreMarker], line, index, node }
 * where `index` is the 0-based content-block index and -1 marks an orphan marker
 * chunk. `content` is the block body with marker spans removed and ASCII-trimmed,
 * byte-identical to the string core's `content` on the §5.2-agreeing subset.
 *
 * Throws if a top-level node lacks `position`: source-slice hashing (§8) needs
 * offsets, so a positionless (post-transform / synthetic) node cannot be hashed
 * or sliced and silently dropping it would hide real stays. Run remark-stay at
 * annotate time, right after the parser, before transforms strip positions.
 */
export function extractBlocks(tree, source, opts = {}) {
  const { mdx = false } = opts;

  // 0. Leading YAML frontmatter is metadata, not content (SPEC.md §5), so it is
  //    excluded before anything is classified. The string core blanks the span; a
  //    tree adapter cannot rewrite the source it was handed, so it drops the nodes
  //    that lie inside the span instead. Doing it by SOURCE span rather than by node
  //    type is what keeps the adapter agreeing with itself with and without
  //    `remark-frontmatter` loaded (one `yaml` node vs a thematicBreak plus a setext
  //    heading), and agreeing with the string core either way.
  const fm = frontmatterSpan(source);

  // 1. Classify each top-level child, then reconstruct blank-line chunks: a
  //    maximal run of nodes with no blank line between consecutive nodes (mirrors
  //    the string core's `segmentBlankLine`, but on tree nodes so §5.2 constructs
  //    stay whole).
  const chunks = [];
  let cur = null;
  let prevEnd = null;
  for (const node of tree.children) {
    if (!node.position) {
      throw new TypeError(
        `remark-stay: node of type "${node.type}" has no position; ` +
          `run remark-stay directly after the parser (positions are required for ` +
          `source-slice hashing, §8) and before transforms that strip them`
      );
    }
    // Entirely inside the frontmatter: not a block at all.
    if (fm && node.position.end.offset <= fm.endOffset) continue;
    // Straddling the closing fence (`...` as the closer, with content on the next
    // line, parses as one paragraph): keep the content half, cut the metadata half.
    // Dropping the whole node here would silently destroy real content, which is
    // the failure mode this rule is written to avoid everywhere else.
    const clamp =
      fm && node.position.start.offset < fm.endOffset
        ? { offset: fm.endOffset, line: clampedStartLine(source, fm, node) }
        : null;
    const item = classify(node, source, mdx, clamp);
    const startLine = item.startLine;
    if (cur && startLine - prevEnd >= BLANK_GAP) cur = null;
    if (!cur) {
      cur = { startLine, items: [] };
      chunks.push(cur);
    }
    cur.items.push(item);
    prevEnd = node.position.end.line;
  }

  // 2. Build blocks chunk by chunk. Within a chunk a marker binds the content
  //    node it shares the chunk with: leading markers bind the following content
  //    (a marker on its own line directly above a paragraph), later markers bind
  //    the preceding content (trailing / marker-only-line). A chunk with no
  //    content node is a marker-only chunk: it binds the previous content block,
  //    or is an orphan with none (§5).
  const blocks = [];
  let cidx = 0;
  let prevContent = null;

  for (const chunk of chunks) {
    let lastInChunk = null; // most recent content block created in this chunk
    let anyContent = false;
    const pending = []; // leading markers awaiting the chunk's next content node

    for (const item of chunk.items) {
      if (item.markerOnly) {
        if (lastInChunk) lastInChunk.m.push(...item.entries);
        else pending.push(...item.entries);
        continue;
      }
      anyContent = true;
      const block = {
        content: item.content,
        // The chunk's first content block takes the chunk start line (which may be
        // a leading marker's line), matching the string core's chunk-start line.
        line: lastInChunk ? item.startLine : chunk.startLine,
        index: cidx++,
        node: item.node,
        m: [...pending.splice(0), ...item.entries],
      };
      blocks.push(block);
      lastInChunk = block;
      prevContent = block;
    }

    if (!anyContent) {
      if (prevContent) prevContent.m.push(...pending);
      else blocks.push({ content: "", line: chunk.startLine, index: -1, node: null, m: [...pending] });
    }
  }

  // 3. Finalize marker order (document order by source offset) and shed the
  //    internal accumulator.
  for (const b of blocks) {
    b.markers = b.m.sort((x, y) => x.off - y.off).map((x) => x.mk);
    delete b.m;
  }
  return blocks;
}

/**
 * Public attachment view (SPEC.md §5.2): one entry per bound marker plus orphans.
 * Built from `extractBlocks`, so it shares the exact attachment semantics the
 * lint/diff/resolve paths use.
 * Returns [{ id, hash, malformed, blockNode, markerLine, orphan }].
 */
export function attach(tree, source, opts = {}) {
  const stays = [];
  for (const b of extractBlocks(tree, source, opts)) {
    const orphan = b.index === -1;
    for (const mk of b.markers) {
      stays.push({
        id: mk.id,
        hash: mk.hash,
        malformed: mk.malformed,
        blockNode: orphan ? null : b.node,
        markerLine: mk.line,
        orphan,
      });
    }
  }
  return stays;
}
