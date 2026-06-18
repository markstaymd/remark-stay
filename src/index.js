// remark-stay: the mdast/remark adapter for markstay (SPEC.md v1.1, §5.2 tree
// attachment). Default export is the unified plugin; the named exports are the
// tree-level building blocks, each reusing the string core's pure functions over
// tree-segmented blocks (impl/js stays the single source of the algorithms).
//
// Tree functions take (tree, source): `source` is the exact Markdown the tree was
// parsed from, whose offsets drive source-slice body hashing (§8). Pass
// { mdx: true } when MDX comment-expression markers should be detected (requires
// remark-mdx upstream so they are mdxFlow/TextExpression nodes).

export { default } from "./plugin.js";
export { extractBlocks, attach } from "./attach.js";
export { serializeHash } from "./serialize.js";
export {
  lintTree,
  diffTrees,
  anchorsFromTree,
  resolveTree,
  sortFindings,
  bodyHash,
} from "./lint.js";
