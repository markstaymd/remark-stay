// M1/M2 parity harness: feed the shared conformance corpus (the §5.2-AGREEING
// subset) through the tree adapter and assert it produces the same blocks,
// findings, hashes, diffs, and resolutions as the string core. Any vector where
// the tree segmenter legitimately differs from blank-line segmentation (loose
// list, blank-line fence, blockquote-with-blank) is a §5.2-only case and lives in
// the tree-only corpus tier, not here.

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

function load(category) {
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
    await t.test(`${tier}:${v.name}`, () => {
      const { tree, source, mdx } = parse(v.doc);
      const got = extractBlocks(tree, source, { mdx }).map(blockShape);
      assert.deepEqual(got, v.blocks);
    });
  }
});

// --- lint: tree findings match string-core findings -----------------------
test("lint parity (findings)", async (t) => {
  for (const { tier, v } of load("lint")) {
    await t.test(`${tier}:${v.name}`, () => {
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
    await t.test(`${tier}:${v.name}`, () => {
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

// --- diff: tree regeneration diff matches string-core lintDiff -------------
test("diff parity", async (t) => {
  for (const { tier, v } of load("diff")) {
    await t.test(`${tier}:${v.name}`, () => {
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
    await t.test(`${tier}:${v.name}`, () => {
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

// --- attach view sanity ----------------------------------------------------
test("attach view binds the preceding block", () => {
  const { tree, source } = parse("A para.\n<!-- stay:a -->\n");
  const stays = attach(tree, source);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].id, "a");
  assert.equal(stays[0].orphan, false);
  assert.ok(stays[0].blockNode);
});
