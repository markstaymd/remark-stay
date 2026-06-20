// Type declarations for remark-stay, the mdast/remark adapter for markstay
// (SPEC.md v1.1, §5.2 tree attachment). Hand-written to match the runtime shapes
// in this directory; the block/finding/anchor/resolution shapes are re-used from
// the string core's published types (import type ... from "markstay").

import type { Plugin } from "unified";
import type { Root, Nodes, RootContent } from "mdast";
import type { Anchor, Block, Finding, Resolution } from "markstay";

export type { Anchor, Block, Finding, Resolution } from "markstay";

/** Options accepted by the tree-level building blocks. */
export interface TreeOptions {
  /**
   * Detect MDX comment-expression markers (`{/* stay:... *\/}`). Requires
   * remark-mdx upstream so the markers are mdxFlow/TextExpression nodes.
   */
  mdx?: boolean;
}

/** A source snapshot: a parsed tree paired with the exact Markdown it came from. */
export interface TreeSnapshot {
  tree: Root;
  source: string;
}

/**
 * A content block segmented from an mdast tree (SPEC.md §5.2). Same shape as the
 * string core's `Block`, plus the originating top-level node (null for an orphan
 * marker chunk).
 */
export interface TreeBlock extends Block {
  node: RootContent | null;
}

/** One attached marker in the public attachment view (`attach`). */
export interface AttachedStay {
  id: string | null;
  hash: string | null;
  malformed: boolean;
  /** The top-level node the marker binds to, or null when orphaned. */
  blockNode: RootContent | null;
  /** 1-based line of the marker. */
  markerLine: number;
  orphan: boolean;
}

/** One bound, well-formed marker in the plugin's `file.data.stay` annotation. */
export interface StayInfo {
  id: string;
  hash: string | null;
  /** True when this id's stored hash no longer matches its current body. */
  drift: boolean;
  line: number;
  /** mdast node type of the bound block, or null. */
  blockType: string | null;
}

/** The `file.data.stay` payload attached in `annotate` / `both` modes. */
export interface StayData {
  stays: StayInfo[];
  findings: Finding[];
  /** Present only when a `baseline` was supplied: the §11 regeneration diff. */
  diff?: Finding[];
  /** Present only when a `baseline` was supplied: the §9.1 resolve verdicts. */
  resolutions?: Record<string, Resolution>;
}

/** Options for the `remarkStay` unified plugin. */
export interface RemarkStayOptions {
  /**
   * - `lint`: emit each finding as a vfile message.
   * - `annotate`: attach `file.data.stay`.
   * - `both` (default): do both.
   */
  mode?: "lint" | "annotate" | "both";
  /** Detect MDX comment-expression markers (needs remark-mdx upstream). */
  mdx?: boolean;
  /**
   * Prior document (Markdown string or a parsed `{ tree, source }`); runs the
   * §11 regeneration diff and the §9.1 resolve ladder against this tree.
   */
  baseline?: string | TreeSnapshot | null;
  /** Mark error-level findings fatal so a remark-cli / unified run exits non-zero. */
  fail?: boolean;
}

/** Resolve options: tree segmentation plus the QUOTE-tier thresholds. */
export interface ResolveTreeOptions extends TreeOptions {
  threshold?: number;
  margin?: number;
}

/**
 * Segment an mdast tree into content blocks with attached markers (SPEC.md §5.2).
 * `source` is the exact Markdown the tree was parsed from; its offsets drive
 * source-slice body hashing (§8). Throws if a top-level node lacks `position`.
 */
export function extractBlocks(tree: Root, source: string, opts?: TreeOptions): TreeBlock[];

/** Public attachment view (SPEC.md §5.2): one entry per bound marker, plus orphans. */
export function attach(tree: Root, source: string, opts?: TreeOptions): AttachedStay[];

/**
 * SHA-256 of the §8-normalized re-serialization of `node`, markers removed
 * (optionally truncated). Drift-only: NOT byte-identical to the source-slice
 * hash, so it must not be used as the cross-implementation digest.
 */
export function serializeHash(node: Nodes, length?: number | null): string;

/** Well-formedness + intra-document findings over a tree (SPEC.md §7 / §8 / §10). */
export function lintTree(
  tree: Root,
  source: string,
  opts?: TreeOptions
): { blocks: TreeBlock[]; findings: Finding[] };

/** Regeneration diff between two tree snapshots (SPEC.md §11). */
export function diffTrees(before: TreeSnapshot, after: TreeSnapshot, opts?: TreeOptions): Finding[];

/** Build §9 anchors (full-body hash + quote selector per marked block) from a tree. */
export function anchorsFromTree(tree: Root, source: string, opts?: TreeOptions): Anchor[];

/** Resolve baseline anchors against an edited tree via the §9.1 ladder. */
export function resolveTree(
  anchors: Anchor[],
  tree: Root,
  source: string,
  opts?: ResolveTreeOptions
): Record<string, Resolution>;

/** Canonical finding order (re-exported from the string core). */
export function sortFindings(findings: Finding[]): Finding[];

/** Body hash (re-exported from the string core, SPEC.md §8). */
export function bodyHash(text: string, length?: number | null): string;

/**
 * The remark plugin: lint, annotate, and (with a `baseline`) run the §11
 * regeneration diff over the tree the unified pipeline already built.
 */
declare const remarkStay: Plugin<[RemarkStayOptions?], Root>;
export default remarkStay;
