// M6: intra-pipeline §11 transform-safety. Proves the guardrail the tree adapter
// has and the string core can't: a downstream transform that drops or mutates a
// stay-bearing node is caught. Both directions are asserted , a dropped stay is
// flagged DROPPED_ID (and fatal under `fail: true`), and a surviving stay still
// resolves through the §9.1 ladder.
//
// The load-bearing discipline (PLAN_REMARK_STAY.md Risks "Positions
// post-transform"): source-slice hashing is only valid right after parse, so the
// baseline is snapshotted at parse time and the "after" document is the re-parsed
// serialization of the mutated tree. The mutated tree is never source-sliced; its
// stale offsets are only touched through the drift-only serializeHash.

import { test } from "node:test";
import assert from "node:assert/strict";

import { unified } from "unified";
import remarkParse from "remark-parse";
import { VFile } from "vfile";
import { toMarkdown } from "mdast-util-to-markdown";

import { bodyHash } from "markstay";
import remarkStay, {
  attach,
  anchorsFromTree,
  diffTrees,
  resolveTree,
  serializeHash,
} from "../src/index.js";

const BEFORE = `# Release notes <!-- stay:title -->

The quick brown fox jumps over the lazy dog. <!-- stay:fox -->

Second paragraph, unrelated to the others. <!-- stay:second -->

Closing remarks live at the very end. <!-- stay:closing -->
`;

const parser = unified().use(remarkParse);

// Snapshot the baseline at parse time, then run a transform that drops `fox`,
// moves `closing` to the front, and edits `second` in place. Returns the frozen
// baseline plus the re-parsed post-transform document, ready for diff/resolve.
function mutate() {
  const beforeTree = parser.parse(BEFORE);
  const anchors = anchorsFromTree(beforeTree, BEFORE);
  const serBefore = new Map(
    attach(beforeTree, BEFORE)
      .filter((s) => !s.orphan)
      .map((s) => [s.id, serializeHash(s.blockNode)])
  );

  // Mutate a working tree (positions still valid at capture time).
  const tree = parser.parse(BEFORE);
  const byId = new Map(attach(tree, BEFORE).map((s) => [s.id, s.blockNode]));
  const fox = byId.get("fox");
  const closing = byId.get("closing");
  const second = byId.get("second");
  tree.children = tree.children.filter((n) => n !== fox);
  tree.children = [closing, ...tree.children.filter((n) => n !== closing)];
  second.children.find((c) => c.type === "text").value += " (edited downstream)";

  const afterSource = toMarkdown(tree); // serialize the mutated tree (no offsets used)
  const afterTree = parser.parse(afterSource); // re-parse -> fresh, valid positions
  return { beforeTree, anchors, serBefore, mutatedTree: tree, afterSource, afterTree };
}

test("a dropped stay is caught: DROPPED_ID + resolves detached", () => {
  const { beforeTree, anchors, afterTree, afterSource } = mutate();

  const diff = diffTrees({ tree: beforeTree, source: BEFORE }, { tree: afterTree, source: afterSource });
  const dropped = diff.filter((f) => f.code === "DROPPED_ID").map((f) => f.id);
  assert.deepEqual(dropped, ["fox"], "fox is reported dropped, nothing else");
  assert.equal(diff.find((f) => f.code === "DROPPED_ID").level, "error", "DROPPED_ID is an error");

  // The in-place edit of `second` only surfaces as HASH_DRIFT because the "after"
  // document is the re-parsed serialization of the mutated tree. Source-slicing
  // the mutated tree with stale offsets would read `second`'s original text and
  // miss the edit, so this assertion is what makes the re-parse discipline
  // load-bearing here (not just the id-presence-keyed DROPPED check above).
  const drift = diff.filter((f) => f.code === "HASH_DRIFT").map((f) => f.id);
  assert.deepEqual(drift, ["second"], "an in-place edit is caught as drift only via re-parse");

  const resolutions = resolveTree(anchors, afterTree, afterSource);
  assert.equal(resolutions.fox.method, "detached", "dropped stay cannot be recovered");
  assert.equal(resolutions.fox.target, null);
});

test("a surviving stay still resolves through the ladder (incl. a moved block)", () => {
  const { anchors, afterTree, afterSource } = mutate();
  const resolutions = resolveTree(anchors, afterTree, afterSource);

  for (const id of ["title", "second", "closing"]) {
    assert.equal(resolutions[id].method, "marker", `${id} resolves via the surviving marker`);
    assert.equal(typeof resolutions[id].target, "number", `${id} maps to a block`);
  }
  // `closing` was moved to the front: identity is position-independent, so a move
  // is NOT a false drop or relocation.
  assert.equal(resolutions.closing.target, 0, "moved block resolves at its new position");
});

test("plugin path: baseline + fail:true marks the dropped stay fatal", async () => {
  const { afterSource } = mutate();

  // Run the after-document through the plugin with the baseline; the §11 diff runs
  // inside the pipeline and DROPPED_ID becomes a fatal vfile message under fail.
  const proc = unified().use(remarkParse).use(remarkStay, { baseline: BEFORE, fail: true, mode: "both" });
  const file = new VFile({ value: afterSource });
  const tree = proc.parse(afterSource);
  await proc.run(tree, file);

  const diffCodes = file.data.stay.diff.map((f) => f.code);
  assert.ok(diffCodes.includes("DROPPED_ID"), "diff annotation records the drop");

  const fatal = file.messages.find((m) => m.ruleId === "DROPPED_ID");
  assert.ok(fatal, "a DROPPED_ID message is emitted");
  assert.equal(fatal.fatal, true, "fail:true makes the dropped stay fatal (build-gating)");
  assert.equal(fatal.source, "remark-stay");
});

test("plugin path: without fail, the same drop is a non-fatal error message", async () => {
  const { afterSource } = mutate();
  const proc = unified().use(remarkParse).use(remarkStay, { baseline: BEFORE, mode: "both" });
  const file = new VFile({ value: afterSource });
  const tree = proc.parse(afterSource);
  await proc.run(tree, file);

  const msg = file.messages.find((m) => m.ruleId === "DROPPED_ID");
  assert.ok(msg, "the drop is still reported");
  assert.equal(msg.fatal, false, "default fail:false keeps it a warning-severity message");
});

test("serializeHash flags in-place drift without re-parsing or source-slicing", () => {
  const { serBefore, mutatedTree } = mutate();

  // `second` was edited in place; recomputing serializeHash over the mutated node
  // (offsets are stale, never used) detects the drift against the snapshot.
  const survivors = new Map();
  for (const node of mutatedTree.children) {
    const m = JSON.stringify(node).match(/<!--\s*stay:([\w-]+)/);
    if (m) survivors.set(m[1], node);
  }
  assert.notEqual(serializeHash(survivors.get("second")), serBefore.get("second"), "edited block drifts");
  assert.equal(serializeHash(survivors.get("title")), serBefore.get("title"), "untouched block does not drift");
});

test("serializeHash is the drift-only profile, not the normative source-slice hash", () => {
  // The snapshot anchors carry source-slice hashes (the cross-impl digest);
  // serializeHash is a separate, remark-normalized profile. M6 must not conflate
  // them: a setext heading proves they differ even with identical content.
  const doc = "Title\n=====\n";
  const node = parser.parse(doc).children[0];
  const sourceSlice = bodyHash(doc.slice(node.position.start.offset, node.position.end.offset));
  assert.notEqual(serializeHash(node), sourceSlice, "serialize profile must not equal source-slice");
});

// A `dumber`-style transform (the real CLI: MichelBoucey/dumber): renumber the
// section headings and inject a table of contents at a `<!-- ToC -->` sentinel.
// This is the §11 transform-safety stressor flagged in the crates.io ecosystem
// scan: an in-place heading rewrite plus a block inserted above every stay. The
// fixture pins that the stay stays bound to the *right* heading across it , a
// renumber drifts (content changed) but never drops or relocates the id, the ToC
// insert shifts every index yet relocates nothing (RELOCATED_ID is content-keyed,
// not position-keyed), and the `<!-- ToC -->` sentinel is NOT mistaken for a stay
// marker (the HTML-comment carrier markstay rejected for identity, §3/SPEC_DECISIONS).
const DUMBER_BEFORE = `# Guide <!-- stay:guide -->

## Introduction <!-- stay:intro -->

Intro paragraph, unchanged by the pass. <!-- stay:intro-body -->

## Installation <!-- stay:install -->

Install paragraph, unchanged by the pass. <!-- stay:install-body -->
`;

// Renumber the `##` section headings in place and splice a ToC (a `<!-- ToC -->`
// sentinel + a bullet list) directly after the title. Mutates a working tree;
// returns the frozen baseline plus the re-parsed post-transform document. The
// synthetic ToC nodes carry no `position`, so per the M6 discipline they are only
// serialized (never source-sliced) and the re-parse hands back valid offsets.
function dumber() {
  const beforeTree = parser.parse(DUMBER_BEFORE);
  const anchors = anchorsFromTree(beforeTree, DUMBER_BEFORE);

  const tree = parser.parse(DUMBER_BEFORE);
  const byId = new Map(attach(tree, DUMBER_BEFORE).map((s) => [s.id, s.blockNode]));

  // 1. Renumber: prepend "N. " to each section heading's text (the trailing stay
  //    marker is a separate `html` child, untouched).
  let n = 0;
  for (const id of ["intro", "install"]) {
    n += 1;
    const text = byId.get(id).children.find((c) => c.type === "text");
    text.value = `${n}. ${text.value}`;
  }

  // 2. Inject the ToC right after the title (index 0). Synthetic nodes, no position.
  const sentinel = { type: "html", value: "<!-- ToC -->" };
  const item = (label) => ({
    type: "listItem",
    spread: false,
    children: [{ type: "paragraph", children: [{ type: "text", value: label }] }],
  });
  const toc = { type: "list", ordered: false, spread: false, children: [item("Introduction"), item("Installation")] };
  tree.children.splice(1, 0, sentinel, toc);

  const afterSource = toMarkdown(tree);
  const afterTree = parser.parse(afterSource);
  return { beforeTree, anchors, afterTree, afterSource };
}

test("dumber renumber: a heading rewrite drifts but never drops or relocates the stay", () => {
  const { beforeTree, afterTree, afterSource } = dumber();
  const diff = diffTrees({ tree: beforeTree, source: DUMBER_BEFORE }, { tree: afterTree, source: afterSource });

  // The two renumbered headings are the only findings, and only as drift.
  const drift = diff.filter((f) => f.code === "HASH_DRIFT").map((f) => f.id).sort();
  assert.deepEqual(drift, ["install", "intro"], "renumbered headings drift (content changed in place)");

  // Crucially: no stay is dropped or relocated. The renumber edits heading text,
  // and the ToC insert shifts every index , neither detaches an id from its block.
  assert.deepEqual(diff.filter((f) => f.code === "DROPPED_ID"), [], "no stay dropped by the renumber/ToC pass");
  assert.deepEqual(diff.filter((f) => f.code === "RELOCATED_ID"), [], "an index shift is not a relocation");
});

test("dumber ToC: the inserted block adds no id and the `<!-- ToC -->` sentinel is not a stay", () => {
  const { afterTree, afterSource } = dumber();

  // The ToC list and the `<!-- ToC -->` sentinel carry no stay marker, so the diff
  // reports no NEW_ID and the after-document's ids are exactly the original five.
  const diff = diffTrees(
    { tree: parser.parse(DUMBER_BEFORE), source: DUMBER_BEFORE },
    { tree: afterTree, source: afterSource }
  );
  assert.deepEqual(diff.filter((f) => f.code === "NEW_ID"), [], "ToC injection mints no id (no marker to mistake)");

  const stays = attach(afterTree, afterSource);
  assert.deepEqual(
    stays.map((s) => s.id).sort(),
    ["guide", "install", "install-body", "intro", "intro-body"],
    "the `<!-- ToC -->` sentinel and ToC list contribute no stay"
  );
  assert.deepEqual(stays.filter((s) => s.orphan), [], "the inserted ToC produces no orphan marker");
});

test("dumber: every surviving stay resolves through the ladder past the inserted ToC", () => {
  const { anchors, afterTree, afterSource } = dumber();
  const resolutions = resolveTree(anchors, afterTree, afterSource);

  for (const id of ["guide", "intro", "intro-body", "install", "install-body"]) {
    assert.equal(resolutions[id].method, "marker", `${id} resolves via its surviving marker`);
    assert.equal(typeof resolutions[id].target, "number", `${id} maps to a block despite the index shift`);
  }
  // The renumbered heading keeps its identity: same id, new (drifted) body, still
  // bound to the same logical heading , not the paragraph that followed it.
  assert.ok(resolutions.intro.target < resolutions["intro-body"].target, "intro stays above its body");
  assert.ok(resolutions.install.target < resolutions["install-body"].target, "install stays above its body");
});
