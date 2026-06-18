// remarkStay plugin behaviour: annotate (file.data.stay), lint (vfile messages),
// the §11 baseline diff, fail-gating, and the MDX profile. Transforms are driven
// with `.run()` so no stringifier dependency is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import { VFile } from "vfile";

import remarkStay from "../src/plugin.js";

/** Run remarkStay over `md` and return the populated vfile. */
async function runStay(md, options = {}, plugins = []) {
  let proc = unified().use(remarkParse);
  for (const p of plugins) proc = proc.use(p);
  proc = proc.use(remarkStay, options);
  const file = new VFile({ value: md });
  const tree = proc.parse(file);
  await proc.run(tree, file);
  return file;
}

const codes = (file) => file.messages.map((m) => m.ruleId);

test("annotate: file.data.stay lists stays with block type and line", async () => {
  const file = await runStay("A para.\n<!-- stay:a -->\n\n```\ncode\n```\n<!-- stay:c -->\n", {
    mode: "annotate",
  });
  assert.equal(file.messages.length, 0, "annotate mode emits no messages");
  const { stays } = file.data.stay;
  assert.deepEqual(
    stays.map((s) => ({ id: s.id, blockType: s.blockType, drift: s.drift })),
    [
      { id: "a", blockType: "paragraph", drift: false },
      { id: "c", blockType: "code", drift: false },
    ]
  );
});

test("lint: malformed / orphan / duplicate surface as messages with lines", async () => {
  const file = await runStay("<!-- stay:loose -->\n\nReal.\n<!-- stay:loose -->\n", { mode: "lint" });
  // loose is an orphan at the top, then a duplicate on the real block.
  assert.ok(codes(file).includes("ORPHAN_MARKER"));
  assert.ok(codes(file).includes("DUPLICATE_ID"));
  const orphan = file.messages.find((m) => m.ruleId === "ORPHAN_MARKER");
  assert.equal(orphan.line, 1);
  assert.equal(orphan.source, "remark-stay");
});

test("lint: hash drift is a warning, not fatal", async () => {
  const file = await runStay("Edited body.\n<!-- stay:x hash=sha256:dead -->\n", { mode: "lint" });
  const drift = file.messages.find((m) => m.ruleId === "HASH_DRIFT");
  assert.ok(drift, "expected HASH_DRIFT");
  assert.equal(drift.fatal, false);
});

test("baseline: a dropped id is reported via the §11 diff", async () => {
  const before = "Keep me.\n<!-- stay:keep -->\n\nDrop me.\n<!-- stay:gone -->\n";
  const after = "Keep me.\n<!-- stay:keep -->\n\nDrop me.\n"; // gone's marker removed
  const file = await runStay(after, { mode: "both", baseline: before });
  assert.ok(codes(file).includes("DROPPED_ID"), "expected DROPPED_ID");
  const dropped = file.data.stay.diff.find((f) => f.code === "DROPPED_ID");
  assert.equal(dropped.id, "gone");
  // keep survived: its marker is still attached (resolve tier 1).
  assert.equal(file.data.stay.resolutions.keep.method, "marker");
});

test("fail: error-level findings become fatal when fail:true", async () => {
  const fatalFile = await runStay("<!-- stay:orphan -->\n", { mode: "lint", fail: true });
  const orphan = fatalFile.messages.find((m) => m.ruleId === "ORPHAN_MARKER");
  assert.equal(orphan.fatal, true);

  const softFile = await runStay("<!-- stay:orphan -->\n", { mode: "lint", fail: false });
  assert.equal(softFile.messages.find((m) => m.ruleId === "ORPHAN_MARKER").fatal, false);
});

test("mdx: comment-expression markers are detected with remark-mdx + mdx:true", async () => {
  const file = await runStay(
    "An MDX block.\n{/* stay:mdx1 hash=sha256:abcd */}\n",
    { mode: "both", mdx: true },
    [remarkMdx]
  );
  assert.deepEqual(
    file.data.stay.stays.map((s) => s.id),
    ["mdx1"]
  );
  // body "An MDX block." does not hash to abcd -> drift.
  assert.ok(codes(file).includes("HASH_DRIFT"));
});

test("mdx off: an MDX marker is invisible (plain text, no node)", async () => {
  const file = await runStay("An MDX block.\n{/* stay:mdx1 */}\n", { mode: "both", mdx: false });
  assert.equal(file.data.stay.stays.length, 0);
});

test("unknown mode throws (no silent no-op)", async () => {
  await assert.rejects(runStay("x\n<!-- stay:a -->\n", { mode: "report" }), /unknown mode/);
});
