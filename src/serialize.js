// Serialize-based body hash: the DRIFT-ONLY hashing profile (SPEC.md §8 +
// remark-stay Milestone 0 decision). After a downstream transform mutates the
// tree, node positions are stale or gone, so the normative source-slice hash is
// unavailable; re-serializing the node and hashing that detects whether the body
// changed. remark's serializer normalizes some syntax (setext -> ATX headings,
// fence info strings, bullet style, spacing), so this hash is NOT byte-identical
// to the source-slice hash and MUST NOT be used as the cross-implementation
// digest. Use it only to answer "did this block drift during the pipeline?".

import { toMarkdown } from "mdast-util-to-markdown";
import { bodyHash, stripMarkers } from "markstay";

/**
 * SHA-256 of the §8-normalized re-serialization of `node`, with markers removed
 * (optionally truncated to `length` hex chars). The §8 hash input is the body
 * with markers stripped (§3), so an inline-trailing marker that `toMarkdown`
 * re-emits must not change the digest. Stripping uses the core's raw `stripMarkers`,
 * which is code-blind, so since SPEC.md §3.3 (v1.5) this is NOT the string core's
 * body definition: the core keeps a marker-shaped string inside a fence and this
 * strips it. That costs nothing here because the hash is drift-only and never the
 * conformance digest, and re-serialization has already renormalized the syntax the
 * §8 digest is taken over. See the module note.
 */
export function serializeHash(node, length = null) {
  return bodyHash(stripMarkers(toMarkdown(node)), length);
}
