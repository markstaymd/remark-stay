// Leading YAML frontmatter as a SOURCE span (SPEC.md §5). The string core blanks
// the span before segmenting; a tree adapter cannot do that (it is handed a tree
// someone else parsed), so it needs the same span expressed in offsets and drops
// or clamps the nodes that fall inside it.
//
// The recognition rule is deliberately identical to the core's `_blank_frontmatter`
// (linter/markstay_lint.py), NOT to whatever `remark-frontmatter` happens to
// recognize: the adapter must produce the same blocks whether or not that plugin is
// in the pipeline. With the plugin loaded the span is one `yaml` node; without it,
// the same bytes parse as a thematicBreak plus a setext heading. Both fall inside
// this span and both are dropped, so the two pipelines agree with each other and
// with the string core.

const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const BLANK_LINE = /^[ \t\f\v]*$/;
// One payload line that could only be YAML, never Markdown prose: a mapping key or
// a list item. A YAML comment (`# ...`) is deliberately NOT accepted: it is
// byte-identical to an ATX heading, so accepting it lets `---` / `# Heading` /
// `---` be read as frontmatter and silently destroy the heading.
//
// `[^\x00-\x20\x7f]` is "not an ASCII control character and not a space", written
// out rather than as `\S`: Python, ECMAScript and Rust each define Unicode
// whitespace differently (U+001C, U+0085, U+00A0 and U+FEFF are each whitespace to
// some and not to others), and this rule DELETES a span from the document, so a
// definition that varies by runtime is the one kind of divergence that loses data.
const YAMLISH_LINE = /^[ \t]*(?:-[ \t]+[^\x00-\x20\x7f]|[^\x00-\x20\x7f:#][^:]*:(?:[ \t]|$))/;

/**
 * Split `source` into line records `{ text, end }`, where `text` excludes the line
 * ending and `end` is the offset of the next line's first character. CRLF and lone
 * CR count as line endings, matching the core's whole-document normalization
 * (which rewrites both to LF before detecting anything).
 */
function lineRecords(source) {
  const out = [];
  const eol = /\r\n|\r|\n/g;
  let start = 0;
  let m;
  while ((m = eol.exec(source)) !== null) {
    out.push({ text: source.slice(start, m.index), end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  out.push({ text: source.slice(start), end: source.length });
  return out;
}

/**
 * The leading frontmatter span of `source`, or null when there is none.
 *
 * Returns `{ endOffset, endLine }`: `endOffset` is the offset of the first
 * character *after* the closing fence's line ending (so a node ending at or before
 * it lies entirely in the metadata), and `endLine` is the 1-based line of the
 * closing fence.
 *
 * All four conditions of the core's rule must hold. They confine the ambiguity
 * rather than removing it: a blank-free payload that reads as YAML is also ordinary
 * Markdown, as a sequence (`---` / `- Keep this` / `---`) or as a mapping under a
 * setext underline (`---` / `title: v` / `---`), and in both the content *is*
 * excluded. A document that fails any of the four conditions falls through to
 * "this is ordinary Markdown", where the worst case is that frontmatter is treated
 * as content (a stray hash-drift warning) rather than content being silently
 * discarded:
 *
 *   1. line 1 is exactly `---`;
 *   2. a later line is exactly `---` or `...`;
 *   3. the payload between them is non-empty and holds no blank line (this is what
 *      stops two thematic breaks around a paragraph from swallowing the paragraph);
 *   4. at least one payload line is unambiguously YAML (this is what stops a
 *      thematic break followed by a setext heading from being read as metadata).
 */
export function frontmatterSpan(source) {
  const lines = lineRecords(source);
  if (!lines.length || !FRONTMATTER_OPEN.test(lines[0].text)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (!FRONTMATTER_CLOSE.test(lines[i].text)) continue;
    const payload = lines.slice(1, i);
    if (!payload.length || payload.some((l) => BLANK_LINE.test(l.text))) return null;
    if (!payload.some((l) => YAMLISH_LINE.test(l.text))) return null;
    return { endOffset: lines[i].end, endLine: i + 1 };
  }
  return null;
}
