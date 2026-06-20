// M6: intra-pipeline §11 transform-safety demo.
//
// The differentiator the *tree* adapter has over the string core: inside a
// unified pipeline a later transform can mutate or drop a node that carries a
// stay, and the string core (no pipeline visibility) can't see it happen. This
// demo shows markstay catching it. The pipeline is:
//
//   remarkParse -> remarkStay(annotate) -> snapshot -> villain -> detect
//
//   * snapshot  banks the §9 anchors (normative source-slice hashes) and a frozen
//               copy of the parse-time tree WHILE node positions still line up
//               with the source (SPEC.md §8 source-slice hashing is only valid
//               right after parse).
//   * villain   a deliberately destructive transform: drops one stay-bearing
//               node, moves another, and edits a third in place.
//   * detect    serializes the MUTATED tree (positions are now stale, so it never
//               source-slices it), re-parses that output to a fresh tree, then
//               runs the §11 regeneration diff + the §9.1 resolve ladder against
//               the snapshot. A dropped stay surfaces as DROPPED_ID and resolves
//               `detached`; a moved/edited stay keeps its identity.
//
// Run: `node examples/transform-safety.mjs`. It prints a per-stay report and
// exits non-zero because a stay was silently dropped (the build-gating signal).

import { unified } from "unified";
import remarkParse from "remark-parse";
import { VFile } from "vfile";
import { toMarkdown } from "mdast-util-to-markdown";

import remarkStay, {
  attach,
  anchorsFromTree,
  diffTrees,
  resolveTree,
  serializeHash,
} from "../src/index.js";

// A document where every block carries a stay.
const BEFORE = `# Release notes <!-- stay:title -->

The quick brown fox jumps over the lazy dog. <!-- stay:fox -->

Second paragraph, unrelated to the others. <!-- stay:second -->

Closing remarks live at the very end. <!-- stay:closing -->
`;

// A standalone parser for the detect step's re-parse (the pipeline's own parser
// is not reachable from inside a transformer without `this`-juggling; a fresh one
// is identical for parse purposes).
const parser = unified().use(remarkParse);

// --- the pipeline plugins -------------------------------------------------

// Bank everything the post-transform checks need, while positions are valid.
function snapshot() {
  return (tree, file) => {
    const source = String(file.value);
    const serByDom = new Map(); // stay id -> serialize-profile hash (drift baseline)
    for (const s of attach(tree, source)) {
      if (!s.orphan) serByDom.set(s.id, serializeHash(s.blockNode));
    }
    file.data.m6 = {
      beforeSource: source,
      beforeTree: structuredClone(tree), // freeze the parse-time tree (offsets stay valid)
      anchors: anchorsFromTree(tree, source), // bank source-slice hashes now
      serBefore: serByDom,
    };
  };
}

// The destructive transform. Captures node references up front (positions still
// valid here, before any edit) via the adapter's own attachment view.
function villain() {
  return (tree, file) => {
    const byId = new Map(attach(tree, String(file.value)).map((s) => [s.id, s.blockNode]));
    const fox = byId.get("fox");
    const closing = byId.get("closing");
    const second = byId.get("second");

    tree.children = tree.children.filter((n) => n !== fox); // 1. silently DROP fox
    tree.children = [closing, ...tree.children.filter((n) => n !== closing)]; // 2. MOVE closing to the top
    second.children.find((c) => c.type === "text").value += " (edited downstream)"; // 3. DRIFT second in place
  };
}

// After the transform: never source-slice the mutated tree. Serialize it, re-parse
// to a fresh tree (valid offsets again), and run §11 diff + §9.1 resolve.
function detect() {
  return (tree, file) => {
    const snap = file.data.m6;
    const afterSource = toMarkdown(tree); // serialize the mutated tree (no offsets used)
    const afterTree = parser.parse(afterSource); // fresh parse -> valid positions

    snap.afterSource = afterSource;
    snap.diff = diffTrees(
      { tree: snap.beforeTree, source: snap.beforeSource },
      { tree: afterTree, source: afterSource }
    );
    snap.resolutions = resolveTree(snap.anchors, afterTree, afterSource);

    // In-place drift, the serializeHash path: recompute over the surviving nodes
    // of the MUTATED tree (no re-parse, no offsets) and compare to the snapshot.
    snap.drift = [];
    for (const s of survivingStays(tree)) {
      const before = snap.serBefore.get(s.id);
      if (before === undefined) continue;
      const now = serializeHash(s.blockNode);
      if (now !== before) snap.drift.push(s.id);
    }
  };
}

// The surviving stays of a (mutated) tree, found by node identity rather than
// offsets: scan top-level children for a trailing stay-marker html node. Good
// enough for the demo's bare `stay:id` markers.
function survivingStays(tree) {
  const out = [];
  for (const node of tree.children) {
    const html = collectHtml(node).find((v) => /<!--\s*stay:([\w-]+)/.test(v));
    if (html) out.push({ id: html.match(/<!--\s*stay:([\w-]+)/)[1], blockNode: node });
  }
  return out;
}
function collectHtml(node, acc = []) {
  if (node.type === "html") acc.push(node.value);
  for (const c of node.children ?? []) collectHtml(c, acc);
  return acc;
}

// The kind of turnkey guard a consumer could promote to public API (kept here as
// a demo illustration; M6 is demo+test only, see PLAN_REMARK_STAY.md follow-ups).
class DroppedStayError extends Error {}
function assertNoDrops(diff) {
  const dropped = diff.filter((f) => f.code === "DROPPED_ID").map((f) => f.id);
  if (dropped.length) {
    throw new DroppedStayError(`pipeline dropped ${dropped.length} stay(s): ${dropped.join(", ")}`);
  }
}

// --- run + report ---------------------------------------------------------

const file = new VFile({ value: BEFORE });
const proc = unified().use(remarkParse).use(remarkStay, { mode: "annotate" }).use(snapshot).use(villain).use(detect);
const tree = proc.parse(BEFORE);
await proc.run(tree, file);

const m6 = file.data.m6;
const dropped = new Set(m6.diff.filter((f) => f.code === "DROPPED_ID").map((f) => f.id));
const driftSet = new Set(m6.drift);

console.log("# markstay M6 , intra-pipeline transform-safety\n");
console.log("Baseline stays (snapshotted at parse time):");
console.log("  " + m6.anchors.map((a) => a.id).join(", ") + "\n");
console.log("Villain transform: dropped `fox`, moved `closing` to the top, edited `second` in place.\n");

console.log("§11 regeneration diff (baseline vs the re-parsed pipeline output):");
if (m6.diff.length === 0) console.log("  (none)");
for (const f of m6.diff) console.log(`  [${f.level}] ${f.code}${f.id ? " " + f.id : ""}`);
console.log("");

console.log("§9.1 resolve ladder (banked anchors -> post-transform document):");
for (const a of m6.anchors) {
  const r = m6.resolutions[a.id];
  const tags = [];
  if (dropped.has(a.id)) tags.push("DROPPED");
  if (driftSet.has(a.id)) tags.push("drift");
  console.log(
    `  ${a.id.padEnd(9)} -> ${r.method.padEnd(8)} target=${r.target === null ? "-" : r.target}` +
      (tags.length ? `   (${tags.join(", ")})` : "")
  );
}
console.log("");
console.log("serializeHash in-place drift (no re-parse): " + (m6.drift.length ? m6.drift.join(", ") : "(none)"));
console.log("");

try {
  assertNoDrops(m6.diff);
  console.log("✓ no stays dropped , pipeline is identity-safe.");
} catch (err) {
  console.error(`✗ GUARD TRIPPED: ${err.message}`);
  console.error("  A block carrying a stay was silently removed by a downstream transform.");
  process.exitCode = 1; // visible non-zero exit: this is the build-gating signal
}
