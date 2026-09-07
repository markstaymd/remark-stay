// M1/M2 parity harness: feed the shared conformance corpus (the §5.2-AGREEING
// subset) through the tree adapter and assert it produces the same blocks,
// findings, hashes, diffs, and resolutions as the string core. Any vector where
// the tree segmenter legitimately differs from blank-line segmentation (loose
// list, blank-line fence, blockquote-with-blank) is a §5.2-only case and lives in
// the tree-only corpus tier, not here.
//
// One class of shared-corpus vector is outside the agreeing subset even though it
// has no lists and no fences: a THEMATIC BREAK not separated from adjacent content
// by a blank line. Blank-line segmentation cannot see that the `---` or `***` is
// its own block, so it joins it to the neighbouring lines while CommonMark splits.
// The corpus carries such documents deliberately , they are the guard cases for the
// leading-frontmatter rule (`---` / `Title` / `---` is a setext heading, not
// metadata), and the three string implementations must agree on them , so this
// harness skips them BY THE PREDICATE below rather than by a list of names, which
// would rot. Frontmatter itself is excluded before the test, since a recognized
// frontmatter span is skipped by both segmenters and therefore does agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";

import {
  bodyHash,
  lintDocument,
  lintDiff,
  sortFindings,
  buildAnchors,
  resolve as resolveStr,
} from "markstay";
import { extractBlocks, attach } from "../src/attach.js";
import { frontmatterSpan } from "../src/frontmatter.js";
import { lintTree, diffTrees, anchorsFromTree, resolveTree } from "../src/lint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "../conformance");

// MDX markers ({/* stay:... */}) are plain paragraph text to a CommonMark parser;
// they only become inspectable nodes once remark-mdx runs. So a vector whose
// markup carries an MDX marker is parsed through the MDX pipeline with mdx:true,
// matching the documented dependency (HTML-comment markers need neither).
const procPlain = unified().use(remarkParse);
const procMdx = unified().use(remarkParse).use(remarkMdx);
const MDX_RE = /\{\/\*\s*stay:/;
const parse = (md) => {
  const mdx = MDX_RE.test(md);
  return { tree: (mdx ? procMdx : procPlain).parse(md), source: md, mdx };
};

// SPEC.md §5 thematic break: 3+ `*`, `-`, or `_` on their own line.
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLANK = /^[ \t\f\v]*$/;
// A fence opener/closer, so a `---` line INSIDE fenced code is not mistaken for a
// thematic break. Skipping a vector that merely quotes `---` in a code block would
// disable parity coverage that is perfectly valid.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * True when `doc` is outside §5's stated agreement subset because it holds a
 * thematic break touching content. A recognized leading frontmatter span is cut
 * first: both segmenters skip it, so its own fences are not a disagreement.
 *
 * Deliberately over-broad in one direction: a paragraph followed by a setext
 * underline (`Body.` / `---`) actually AGREES, since blank-line segmentation joins
 * the two lines into the one block the tree also produces. Telling that apart from
 * a leading break plus a setext heading (which diverges) needs a real parser, and
 * over-skipping costs coverage while under-skipping would report a false pass. No
 * corpus vector has that shape today; if one is added, expect it to be skipped here
 * and check by hand rather than loosening the predicate.
 */
function thematicBreakTouchesContent(doc) {
  const fm = frontmatterSpan(doc);
  const lines = (fm ? doc.slice(fm.endOffset) : doc).split(/\r\n|\r|\n/);
  let fence = null; // the open fence's marker run, or null outside a fence
  return lines.some((ln, i) => {
    const m = FENCE.exec(ln);
    if (fence) {
      // a closer is the same character, at least as long, and nothing else
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !ln.slice(m[0].length).trim()) {
        fence = null;
      }
      return false; // literal content either way
    }
    if (m) {
      fence = m[1];
      return false;
    }
    return (
      THEMATIC.test(ln) &&
      ((i > 0 && !BLANK.test(lines[i - 1])) ||
        (i + 1 < lines.length && !BLANK.test(lines[i + 1])))
    );
  });
}

const outsideSubset = (...docs) =>
  docs.some(thematicBreakTouchesContent) &&
  "outside §5's agreement subset: a thematic break touches content";

/**
 * Why this vector is skipped, or false to run it.
 *
 * Two reasons a shared-corpus vector can sit outside §5.4's agreement subset. One
 * is computed (a thematic break touching content, above). The other is DECLARED by
 * the corpus: a vector carrying `relation: "diverges"` says the two segmenters
 * reach different answers and its `note` says why. SPEC.md §3.3 is what made the
 * declared kind necessary: the rule is about fenced code, so its vectors are about
 * the constructs where a line rule and a real parser part company (an indented
 * code block, a fence behind a list marker or a `>` prefix, an inline span, a
 * marker span crossing a fence boundary). Those must run in the three string
 * runners, so they belong in the shared tier, and they cannot run here.
 *
 * The mark is verified rather than trusted: `declared divergences really diverge`
 * below fails if a vector claims to diverge and does not, so it cannot be used to
 * silence a parity regression.
 */
const skipReason = (v, ...docs) =>
  (v.relation === "diverges" &&
    `declared divergence: ${v.note ?? "outside §5.4's agreement subset"}`) ||
  outsideSubset(...docs);

const blockShape = (b) => ({
  content: b.content,
  index: b.index,
  ids: b.markers.map((m) => m.id),
  line: b.line,
  orphan: b.index === -1,
});
const findingShape = (f, withLine) =>
  withLine
    ? { level: f.level, code: f.code, id: f.id ?? null, line: f.line ?? null }
    : { level: f.level, code: f.code, id: f.id ?? null };

// Which categories a verifier actually consumed. A routing table that only
// DECLARES what is routed can go on declaring it after the test that reads a
// category is deleted, so the declaration is recorded here, at the one place the
// vectors are actually handed out, rather than asserted against a list.
const CONSUMED = new Set();

// Every category the corpus DECLARES, and the file each was read from. The
// declaration is `data.category`, which is what `load` routes on; the filename
// is not, so inventorying names would let a file renamed or re-declared slip
// past while its vectors go unrouted.
function declaredCategories() {
  const seen = new Map();
  for (const tier of ["spec", "gen"]) {
    let names;
    try {
      names = readdirSync(join(CORPUS, tier));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const data = JSON.parse(readFileSync(join(CORPUS, tier, name), "utf8"));
      seen.set(data.category, `${tier}/${name}`);
    }
  }
  return seen;
}

function load(category) {
  CONSUMED.add(category);
  return loadRaw(category);
}

// The same vectors without recording a read. The count assertion below loads
// every routed category to size it, and if that counted as routing it, deleting
// a parity test would leave the "was actually read" check satisfied by the very
// assertion that is supposed to notice.
function loadRaw(category) {
  const out = [];
  for (const tier of ["spec", "gen"]) {
    let names;
    try {
      names = readdirSync(join(CORPUS, tier));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const data = JSON.parse(readFileSync(join(CORPUS, tier, name), "utf8"));
      if (data.category === category) out.push(...data.vectors.map((v) => ({ tier, v })));
    }
  }
  return out;
}

// --- parse: tree blocks match string-core blocks --------------------------
test("parse parity (blocks)", async (t) => {
  for (const { tier, v } of load("parse")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.doc) }, () => {
      const { tree, source, mdx } = parse(v.doc);
      const got = extractBlocks(tree, source, { mdx }).map(blockShape);
      assert.deepEqual(got, v.blocks);
    });
  }
});

// --- lint: tree findings match string-core findings -----------------------
test("lint parity (findings)", async (t) => {
  for (const { tier, v } of load("lint")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.doc) }, () => {
      const { tree, source, mdx } = parse(v.doc);
      const got = sortFindings(lintTree(tree, source, { mdx }).findings).map((f) =>
        findingShape(f, true)
      );
      assert.deepEqual(got, v.findings);
    });
  }
});

// --- hash: source-slice body hash equals the string core on every block ----
test("hash parity (source-slice vs string core)", async (t) => {
  for (const { tier, v } of load("parse")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.doc) }, () => {
      const strBlocks = lintDocument(v.doc).blocks.filter((b) => b.index >= 0);
      const { tree, source, mdx } = parse(v.doc);
      const treeBlocks = extractBlocks(tree, source, { mdx }).filter((b) => b.index >= 0);
      assert.equal(treeBlocks.length, strBlocks.length, "content-block count");
      for (let i = 0; i < strBlocks.length; i++) {
        assert.equal(
          bodyHash(treeBlocks[i].content),
          bodyHash(strBlocks[i].content),
          `block ${i} hash`
        );
      }
    });
  }
});

// --- the declared divergences must really diverge --------------------------
//
// Without this, `relation: "diverges"` would be a way to silence a parity
// regression by editing the corpus. A vector that claims the two segmenters part
// company has to show it, on the same comparison the parity tests make.
test("declared divergences really diverge", async (t) => {
  // `skipReason` honours the mark in every category this file checks, so the
  // guard has to see every category too. It can only VERIFY a parse vector (the
  // comparison is block-shaped), so a mark anywhere else fails loudly here rather
  // than skipping a parity check nothing ever confirms.
  // `loadRaw`, not `load`: inspecting a category's metadata is not verifying its
  // parity, and recording it as read would let this guard stand in for a deleted
  // parity test in the consumption check below.
  const elsewhere = ["lint", "diff", "anchors", "resolve"].flatMap((c) =>
    loadRaw(c).filter(({ v }) => v.relation === "diverges").map(({ v }) => `${c}:${v.name}`)
  );
  assert.deepEqual(
    elsewhere,
    [],
    "a vector outside `parse` declares `relation: \"diverges\"`, which skipReason " +
      "honours but this guard cannot verify; extend the guard for that category " +
      "before relying on the mark there"
  );

  const declared = load("parse").filter(({ v }) => v.relation === "diverges");
  assert.ok(declared.length > 0, "no declared divergences found; is the corpus loaded?");
  for (const { tier, v } of declared) {
    await t.test(`${tier}:${v.name}`, () => {
      const { tree, source, mdx } = parse(v.doc);
      const got = extractBlocks(tree, source, { mdx }).map(blockShape);
      assert.notDeepEqual(
        got,
        v.blocks,
        "declared `relation: \"diverges\"` but the tree agrees with the string core; " +
          "drop the mark rather than carrying a vector that claims a divergence it does not have"
      );
      assert.ok(typeof v.note === "string" && v.note.length > 0, "a declared divergence needs a note saying why");
    });
  }
});

// --- diff: tree regeneration diff matches string-core lintDiff -------------
test("diff parity", async (t) => {
  for (const { tier, v } of load("diff")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.before, v.after) }, () => {
      const before = parse(v.before);
      const after = parse(v.after);
      const opts = { mdx: before.mdx || after.mdx };
      const got = sortFindings(diffTrees(before, after, opts)).map((f) => findingShape(f, false));
      const want = sortFindings(lintDiff(v.before, v.after)).map((f) => findingShape(f, false));
      assert.deepEqual(got, want);
      assert.deepEqual(got, v.findings);
    });
  }
});

// --- resolve: tree ladder matches string-core resolve ---------------------
test("resolve parity", async (t) => {
  for (const { tier, v } of load("resolve")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.before, v.after) }, () => {
      const before = parse(v.before);
      const { tree, source, mdx } = parse(v.after);
      const anchors = anchorsFromTree(before.tree, before.source, { mdx: before.mdx });
      const got = resolveTree(anchors, tree, source, { threshold: v.threshold, margin: v.margin, mdx });

      const strAnchors = buildAnchors(v.before);
      const want = resolveStr(strAnchors, v.after, { threshold: v.threshold, margin: v.margin });

      const shape = (r) =>
        Object.fromEntries(
          Object.keys(r).map((id) => [id, { method: r[id].method, target: r[id].target, score: r[id].score }])
        );
      assert.deepEqual(shape(got), shape(want));
      assert.deepEqual(shape(got), v.resolutions);
    });
  }
});

// --- anchors: tree anchor production matches the string core ---------------
//
// A separate category for the same reason the string runners give it one:
// resolution cannot see what a producer STORED. A tree adapter that anchored
// whole neighbour blocks, or that produced an anchor for a `subhash` marker,
// resolves identically to a conforming one on every resolve vector, because both
// sides window and filter at match time. Only this comparison catches it.
test("anchors parity", async (t) => {
  for (const { tier, v } of load("anchors")) {
    await t.test(`${tier}:${v.name}`, { skip: skipReason(v, v.document) }, () => {
      const { tree, source, mdx } = parse(v.document);
      const got = anchorsFromTree(tree, source, { mdx });
      // The runtime anchor keeps its §9 selector nested; the corpus stores it
      // flat, the same projection `expect_anchors` uses in the Python runner.
      const shape = (a) => ({
        id: a.id,
        hash: a.hash,
        quote: a.selector.quote,
        prefix: a.selector.prefix,
        suffix: a.selector.suffix,
      });
      assert.deepEqual(got.map(shape), buildAnchors(v.document).map(shape));
      assert.deepEqual(got.map(shape), v.anchors);
    });
  }
});

// --- what this harness actually routes -------------------------------------
//
// This adapter is NOT a full corpus runner: it routes the categories whose
// comparison is tree-shaped and leaves marker grammar, hashing, minting, staged
// check and the write path to the local `markstay` core and the four full
// runners. That division is fine, and silently narrowing it is not. Asserting
// the exact per-category counts is what stops a category quietly falling out of
// routing, which would leave a green suite testing less than it says.
const ROUTE_DOCS = [
  ["parse", (v) => [v.doc]],
  ["lint", (v) => [v.doc]],
  ["diff", (v) => [v.before, v.after]],
  ["anchors", (v) => [v.document]],
  ["resolve", (v) => [v.before, v.after]],
];
const ROUTED = ROUTE_DOCS.map(([category]) => category);

test("routed category counts", () => {
  const counts = {};
  for (const [category, docsOf] of ROUTE_DOCS) {
    const loaded = loadRaw(category);
    const skipped = loaded.filter(({ v }) => skipReason(v, ...docsOf(v))).length;
    counts[category] = { routed: loaded.length, skipped };
  }
  assert.deepEqual(counts, {
    parse: { routed: 59, skipped: 14 },
    lint: { routed: 20, skipped: 0 },
    diff: { routed: 13, skipped: 0 },
    anchors: { routed: 4, skipped: 0 },
    resolve: { routed: 35, skipped: 0 },
  });
  const routed = Object.values(counts).reduce((n, c) => n + c.routed, 0);
  assert.equal(routed, 131, "unique core records routed through the tree adapter");
});

// --- what this harness DECLINES, stated rather than left to silence ---------
//
// Asserting the routed counts pins the five categories this harness knows about.
// It says nothing about a category it has never heard of: a new core file in
// spec/ or gen/ is simply not routed, and the suite stays green while testing
// less than the corpus contains. That is the same silence a stale mirror runner
// has for a whole new tier directory, one level down.
//
// So the corpus is inventoried instead of assumed. Every category on disk is
// either routed above or named here with the reason it is not, and a category
// that is neither fails this test by name. Adding one is then a decision someone
// makes rather than an omission nobody sees.
const DECLINED = {
  hash: "byte-level digests: no tree shape to compare",
  mint: "id minting: the string core owns the alphabet and uniqueness",
  preserve: "§11 preservation instructions: no adapter surface",
  check: "staged check: a CLI-shaped comparison",
  score: "resolution scoring: covered through resolve",
  seqmatch: "sequence matching: an internal of the string resolver",
  stamp: "the write path: not implemented in this adapter",
  markers: "raw §4 grammar: below the tree, and the string core's own",
};

test("every core corpus category is routed or declined by name", () => {
  const declared = declaredCategories();
  const known = new Set([...ROUTED, ...Object.keys(DECLINED)]);
  assert.deepEqual(
    [...declared.keys()].filter((c) => !known.has(c)).sort(),
    [],
    "a core corpus category this harness has never heard of",
  );
  assert.deepEqual(
    [...known].filter((c) => !declared.has(c)).sort(),
    [],
    "this harness names a core corpus category the corpus no longer declares",
  );
});

// Declaring a category routed is not the same as routing it. This runs last on
// purpose: node executes a file's tests in declaration order, so by now every
// verifier above has asked `load` for its vectors, and a category that is claimed
// but never asked for shows up as one nobody read.
test("every routed category was actually read by a verifier", () => {
  assert.deepEqual(
    ROUTED.filter((category) => !CONSUMED.has(category)).sort(),
    [],
    "a category this harness claims to route, whose parity test never ran",
  );
  assert.deepEqual(
    [...CONSUMED].filter((category) => !ROUTED.includes(category)).sort(),
    [],
    "a category a verifier read that the routing table does not declare",
  );
});

// --- attach view sanity ----------------------------------------------------
test("attach view binds the preceding block", () => {
  const { tree, source } = parse("A para.\n<!-- stay:a -->\n");
  const stays = attach(tree, source);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].id, "a");
  assert.equal(stays[0].orphan, false);
  assert.ok(stays[0].blockNode);
});

test("attach view excludes exact subhash keys but keeps extension keys", () => {
  const md = [
    "- child <!-- stay:child subhash=bogus -->",
    "<!-- stay:parent -->",
    "",
    "Extension. <!-- stay:extension x-subhash=sha256:abcd -->",
  ].join("\n");
  const { tree, source } = parse(md);
  assert.deepEqual(
    extractBlocks(tree, source).flatMap((block) => block.markers.map((marker) => marker.id)),
    ["child", "parent", "extension"],
    "low-level blocks retain every lexical marker"
  );
  assert.deepEqual(
    attach(tree, source).map((stay) => stay.id),
    ["parent", "extension"]
  );
});
