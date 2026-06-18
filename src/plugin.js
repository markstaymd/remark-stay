// The unified plugin wrapper. `remarkStay` is the integration surface: drop it
// into any unified/remark pipeline to lint, annotate, and (with a baseline) run
// the §11 regeneration diff over the tree the pipeline already built. All verdicts
// come from the core via ./lint.js; this file is purely the unified glue
// (vfile messages, file.data, options).

import { lintTree, diffTrees, anchorsFromTree, resolveTree, sortFindings } from "./lint.js";

// vfile severity: fatal=true -> error, false -> warning, null -> info/message.
function emitMessage(file, f, fail) {
  const place = f.line ? { line: f.line, column: 1 } : undefined;
  const msg = file.message(f.message, { place, ruleId: f.code, source: "remark-stay" });
  msg.fatal = f.level === "error" ? Boolean(fail) : f.level === "warn" ? false : null;
  return msg;
}

// Accept a baseline as a Markdown source string (parsed through the same
// processor, so MDX/plugins apply) or as a pre-parsed { tree, source }.
function normalizeBaseline(baseline, proc) {
  if (typeof baseline === "string") return { tree: proc.parse(baseline), source: baseline };
  if (baseline && baseline.tree && typeof baseline.source === "string") return baseline;
  throw new TypeError("remarkStay: `baseline` must be a Markdown string or { tree, source }");
}

function buildAnnotation(blocks, findings, diff, resolutions) {
  const driftIds = new Set(findings.filter((f) => f.code === "HASH_DRIFT").map((f) => f.id));
  const stays = [];
  for (const b of blocks) {
    if (b.index < 0) continue;
    for (const mk of b.markers) {
      if (mk.malformed) continue;
      stays.push({
        id: mk.id,
        hash: mk.hash,
        drift: driftIds.has(mk.id),
        line: mk.line,
        blockType: b.node ? b.node.type : null,
      });
    }
  }
  const out = { stays, findings };
  if (diff) out.diff = diff;
  if (resolutions) out.resolutions = resolutions;
  return out;
}

/**
 * remark plugin. Options:
 *   mode     'lint' | 'annotate' | 'both'  (default 'both')
 *            - lint: emit each finding as a vfile message (shows in remark-cli,
 *              editors, CI).
 *            - annotate: attach `file.data.stay` = { stays, findings, diff?,
 *              resolutions? }.
 *   mdx      detect MDX comment-expression markers (needs remark-mdx upstream so
 *            the markers are mdxFlow/TextExpression nodes). Default false.
 *   baseline prior document (Markdown string or { tree, source }); runs the §11
 *            regeneration diff (DROPPED / DUPLICATED / RELOCATED / HASH_DRIFT) and
 *            the §9.1 resolve ladder of baseline ids against this tree.
 *   fail     mark error-level findings fatal so a remark-cli / unified run exits
 *            non-zero (gate a build). Default false.
 */
const MODES = new Set(["lint", "annotate", "both"]);

export default function remarkStay(options = {}) {
  const { mode = "both", mdx = false, baseline = null, fail = false } = options;
  if (!MODES.has(mode)) {
    throw new TypeError(`remarkStay: unknown mode ${JSON.stringify(mode)} (expected 'lint' | 'annotate' | 'both')`);
  }
  const proc = this; // unified processor, for parsing a baseline source string

  return function transformer(tree, file) {
    const source = String(file.value ?? "");
    const { blocks, findings: docFindings } = lintTree(tree, source, { mdx });
    let findings = [...docFindings];

    let diff = null;
    let resolutions = null;
    if (baseline != null) {
      const base = normalizeBaseline(baseline, proc);
      diff = diffTrees(base, { tree, source }, { mdx });
      findings = findings.concat(diff);
      const anchors = anchorsFromTree(base.tree, base.source, { mdx });
      resolutions = resolveTree(anchors, tree, source, { mdx });
    }

    findings = sortFindings(findings);

    if (mode === "annotate" || mode === "both") {
      file.data.stay = buildAnnotation(blocks, findings, diff, resolutions);
    }
    if (mode === "lint" || mode === "both") {
      for (const f of findings) emitMessage(file, f, fail);
    }
  };
}
