// The §5.2 tree-only conformance tier (conformance/tree/) plus the two intended
// divergences from the string core. This tier is consumed ONLY here: the vectors
// deliberately differ from blank-line segmentation, so run_py.py and the impl/js
// runner (which read spec/ + gen/) never see them. Each vector pins both
// segmenters and their relationship, so a regression in either is caught.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { unified } from "unified";
import remarkParse from "remark-parse";

import { bodyHash, lintDocument } from "markstay";
import { extractBlocks, attach } from "../src/attach.js";
import { serializeHash } from "../src/serialize.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE_DIR = resolve(HERE, "../conformance/tree");
const proc = unified().use(remarkParse);

const blockShape = (b) => ({
  content: b.content,
  index: b.index,
  ids: b.markers.map((m) => m.id),
  line: b.line,
  orphan: b.index === -1,
});

function treeVectorFiles() {
  return readdirSync(TREE_DIR)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(TREE_DIR, n), "utf8")));
}

const files = treeVectorFiles();
assert.ok(files.length > 0, "no §5.2 vectors found under conformance/tree/");

for (const data of files) {
  test(`tree:${data.category}`, async (t) => {
    for (const v of data.vectors) {
      await t.test(`${v.name} (${v.relation})`, () => {
        const treeBlocks = extractBlocks(proc.parse(v.doc), v.doc).map(blockShape);
        const stringBlocks = lintDocument(v.doc).blocks.map(blockShape);

        // The tree adapter must produce the pinned §5.2 segmentation.
        assert.deepEqual(treeBlocks, v.treeBlocks, "tree blocks");
        // The blank-line baseline must produce the pinned (divergent or agreeing)
        // segmentation, so the relationship is characterized, not assumed.
        assert.deepEqual(stringBlocks, v.stringBlocks, "string-core blocks");

        const same = JSON.stringify(treeBlocks) === JSON.stringify(stringBlocks);
        if (v.relation === "diverges") assert.ok(!same, "expected the two segmenters to diverge");
        else assert.ok(same, "expected the two segmenters to agree");
      });
    }
  });
}

// --- Agreement (was divergence 1 until v1.5): a marker-shaped comment inside a
//     fence is not a stay, under either segmenter. The tree got this for free
//     (the comment is part of the `code` node's literal value); SPEC.md §3.3 now
//     requires it of the string core too, from a line-based fence mask.
test("agreement: marker inside a fence yields no stay, in both views", () => {
  const doc = "```\n<!-- stay:x -->\n```\n";
  assert.deepEqual(attach(proc.parse(doc), doc), [], "no stays in a fence");
  assert.deepEqual(
    lintDocument(doc).blocks.flatMap((b) => b.markers.map((m) => m.id)),
    [],
    "string core honours §3.3"
  );
});

// --- Regression: an HTML block that mixes content and a marker is a content
//     block carrying that marker, not an orphan (mdast merges them into one
//     `html` node; a naive "any html node with a marker is marker-only" drops the
//     content). Must agree with the string core on this agreeing-subset case.
test("mixed html block: content + marker is a content block, matches the string core", () => {
  for (const doc of ["<div>hello</div>\n<!-- stay:x -->\n", "<div><!-- stay:x --></div>\n"]) {
    const shape = (b) => ({ content: b.content, index: b.index, ids: b.markers.map((m) => m.id) });
    const tree = extractBlocks(proc.parse(doc), doc).map(shape);
    const string = lintDocument(doc).blocks.map(shape);
    assert.deepEqual(tree, string, `mixed html: ${JSON.stringify(doc)}`);
    assert.equal(tree[0].index, 0, "is a content block, not an orphan");
    assert.deepEqual(tree[0].ids, ["x"], "carries the marker");
  }
});

// --- Regression: a positionless node fails closed (source-slice hashing needs
//     offsets; silently dropping it would hide stays).
test("positionless node throws (fail closed)", () => {
  const tree = { type: "root", children: [{ type: "paragraph", children: [] }] }; // no position
  assert.throws(() => extractBlocks(tree, "whatever"), /has no position/);
});

// --- Intended divergence 2: source-slice (normative) vs serialize (drift-only).
test("divergence: serialize hash differs from source-slice hash; source-slice matches the core", () => {
  // remark renormalizes a setext heading to ATX on serialize, so the serialize
  // hash drifts from the source-slice hash. The source-slice hash is the one that
  // equals the string core's digest (cross-impl parity), which is why it is
  // normative and serialize is drift-only.
  const doc = "Title\n=====\n";
  const node = proc.parse(doc).children[0];
  const slice = doc.slice(node.position.start.offset, node.position.end.offset);

  const sourceSlice = bodyHash(slice);
  const serialized = serializeHash(node);
  assert.notEqual(sourceSlice, serialized, "serialize must drift from source-slice here");

  // Source-slice equals the string core's hash of the same body (the §8 parity
  // guarantee); serialize does not.
  const coreHash = bodyHash(lintDocument(doc).blocks[0].content);
  assert.equal(sourceSlice, coreHash, "source-slice hash equals the string core");
  assert.notEqual(serialized, coreHash, "serialize hash is not the cross-impl digest");
});

// --- serializeHash strips markers (§8): an inline-trailing marker that toMarkdown
//     re-emits must not change the digest vs the marker-free body.
test("serializeHash strips inline markers (§8 body, not the raw serialization)", () => {
  const doc = "Body text. <!-- stay:x -->\n";
  const para = proc.parse(doc).children[0];
  assert.equal(serializeHash(para), bodyHash("Body text."), "marker excluded from the hash");
});

// --- leading YAML frontmatter (SPEC.md §5) is excluded by SOURCE span ---------
//
// The adapter must not depend on `remark-frontmatter` being in the pipeline: with
// it, the metadata is one `yaml` node; without it, the same bytes are a
// thematicBreak plus a setext heading. Both fall inside the same source span, so
// both are dropped and the two pipelines agree with each other and with the string
// core. `remark-frontmatter` is a devDependency here and the test skips without it,
// so the published package needs no peer dependency on it.

const frontmatterPlugin = await import("remark-frontmatter").then(
  (m) => m.default,
  () => null
);

test("frontmatter: the same blocks with and without remark-frontmatter", { skip: !frontmatterPlugin && "remark-frontmatter not installed" }, () => {
  const withFm = unified().use(remarkParse).use(frontmatterPlugin, ["yaml"]);
  for (const doc of [
    "---\nstatus: active\nowner: tim\n---\n\n# Heading\n\nBody para.\n",
    "---\ntitle: t\n---\n# Heading\n\nBody.\n",
    "---\ntitle: t\n...\nBody.\n", // `...` closer: the plugin does not match, we do
    "---\nkey: v\n---\n<!-- stay:x -->\n\nBody.\n",
  ]) {
    const plain = extractBlocks(proc.parse(doc), doc).map(blockShape);
    const plugged = extractBlocks(withFm.parse(doc), doc).map(blockShape);
    const string = lintDocument(doc).blocks.map(blockShape);
    assert.deepEqual(plugged, plain, `plugin-independent: ${JSON.stringify(doc)}`);
    assert.deepEqual(plain, string, `matches the string core: ${JSON.stringify(doc)}`);
  }
});

test("frontmatter: a span only remark-frontmatter accepts stays a content block", { skip: !frontmatterPlugin && "remark-frontmatter not installed" }, () => {
  // The documented corner. `remark-frontmatter` is more permissive than SPEC.md §5:
  // it accepts a payload containing a blank line, which the conservative rule
  // rejects (that rule is what stops two thematic breaks around a paragraph from
  // swallowing the paragraph). With the plugin loaded such a span parses as one
  // `yaml` node, and since it is not a frontmatter span by §5 the adapter keeps it
  // as an ordinary content block. Nothing is lost; the segmentation differs from
  // the string core, exactly as it does for any other node the parser groups
  // differently. Pinned so the behaviour is characterized rather than discovered.
  const doc = "---\n\nIntro paragraph.\n\n---\n\nBody.\n";
  const withFm = unified().use(remarkParse).use(frontmatterPlugin, ["yaml"]);
  const plugged = extractBlocks(withFm.parse(doc), doc).map(blockShape);
  const string = lintDocument(doc).blocks.map(blockShape);

  assert.equal(plugged.length, 2, "the plugin folds the whole span into one yaml node");
  assert.ok(plugged[0].content.includes("Intro paragraph."), "content is kept, not dropped");
  assert.notDeepEqual(plugged, string, "and it therefore differs from the string core");
});

test("frontmatter: a fence opened in the payload straddles past a blank line", () => {
  // Found by external review. A code fence opened INSIDE the payload is not closed
  // by the `---`, so the code node runs past the closing fence AND past the blank
  // line after it (fences do not end at blank lines). The surviving content then
  // does not start on `endLine + 1`, and a clamp that assumed it did reported the
  // blank line's number. The string core blanks lines 1-5 and reports `# H` at
  // line 7; the adapter must say 7 too.
  const doc = "---\nkey: v\n```\ncode\n---\n\n# H\n";
  const tree = extractBlocks(proc.parse(doc), doc).map(blockShape);
  const string = lintDocument(doc).blocks.map(blockShape);
  assert.deepEqual(tree, string, "clamped line matches the string core");
  assert.equal(tree.length, 1);
  assert.equal(tree[0].content, "# H");
  assert.equal(tree[0].line, 7);
});

test("frontmatter: a straddling node keeps the half after the closing fence", () => {
  // Regression guard for the clamp: dropping the whole node would silently destroy
  // `Body.`, which is the failure mode the §5 rule is written to avoid.
  const doc = "---\ntitle: t\n...\nBody.\n";
  const blocks = extractBlocks(proc.parse(doc), doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, "Body.");
  assert.equal(blocks[0].line, 4);
});
