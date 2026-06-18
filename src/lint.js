// Lint + diff + resolve over an mdast tree. Pure glue: every verdict comes from
// the string core's block-level functions (lintBlocks / lintDiffBlocks /
// buildAnchorsFromBlocks / resolveOverBlocks); this module only segments the
// tree into blocks (via extractBlocks) and hands them over. That single-sources
// the algorithms with the string core, so the adapter cannot drift from the spec.

import {
  lintBlocks,
  lintDiffBlocks,
  buildAnchorsFromBlocks,
  resolveOverBlocks,
  sortFindings,
  bodyHash,
} from "markstay";
import { extractBlocks } from "./attach.js";

/**
 * Well-formedness + intra-document findings over a tree (SPEC.md §7/§8/§10).
 * Returns { blocks, findings } with findings in detection order; sort with the
 * core's sortFindings for the canonical order. Findings are identical to the
 * string core's `lintDocument` on the §5.2-agreeing subset.
 */
export function lintTree(tree, source, opts = {}) {
  const blocks = extractBlocks(tree, source, opts);
  return { blocks, findings: lintBlocks(blocks) };
}

/** Content blocks only (index >= 0), the input the diff/resolve cores expect. */
function contentBlocks(tree, source, opts) {
  return extractBlocks(tree, source, opts).filter((b) => b.index >= 0);
}

/**
 * Regeneration diff between two trees (SPEC.md §11): DROPPED / DUPLICATED /
 * RELOCATED / NEW / HASH_DRIFT, identical to the string core's `lintDiff` on the
 * agreeing subset. `before`/`after` are { tree, source }.
 */
export function diffTrees(before, after, opts = {}) {
  return lintDiffBlocks(
    extractBlocks(before.tree, before.source, opts),
    extractBlocks(after.tree, after.source, opts)
  );
}

/**
 * Build §9 anchors from a baseline tree (full-body hash + quote selector per
 * marked block), for the §9.1 resolve ladder.
 */
export function anchorsFromTree(tree, source, opts = {}) {
  return buildAnchorsFromBlocks(contentBlocks(tree, source, opts));
}

/**
 * Resolve baseline anchors against an edited tree via the §9.1 ladder
 * (MARKER -> HASH -> QUOTE -> DETACHED). `opts` may carry threshold/margin; the
 * rest is passed to extractBlocks (e.g. mdx).
 */
export function resolveTree(anchors, tree, source, opts = {}) {
  const { threshold, margin, ...rest } = opts;
  return resolveOverBlocks(anchors, contentBlocks(tree, source, rest), { threshold, margin });
}

export { sortFindings, bodyHash };
