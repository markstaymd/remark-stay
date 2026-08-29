# remark-stay , mdast/remark adapter for markstay

[![npm](https://img.shields.io/npm/v/remark-stay)](https://www.npmjs.com/package/remark-stay)
[![bundle size](https://img.shields.io/bundlephobia/minzip/remark-stay)](https://bundlephobia.com/package/remark-stay)
[![tests](https://img.shields.io/github/actions/workflow/status/markstaymd/remark-stay/test.yml?label=tests)](https://github.com/markstaymd/remark-stay/actions/workflows/test.yml)
[![spec](https://img.shields.io/badge/spec-v1.5-blue)](https://markstay.org)
![License](https://img.shields.io/npm/l/remark-stay)

The **integration surface** for [markstay](https://markstay.org) in the
JavaScript Markdown/MDX pipeline ecosystem. The parser-free core (the
[`markstay`](https://www.npmjs.com/package/markstay) package) validates the spec
at the string level; this adapter drops markstay into the pipelines where the use
cases live (MDX, Astro, Next, Docusaurus, AI doc-editing), where the unit of work
is an mdast tree, not raw text.

It is the **third gated implementation** of the [markstay spec](https://markstay.org)
(v1.5), after the Python reference and the zero-dependency JS core. It does not
fork the algorithms: every hash, ratio, lint code, and resolution verdict comes
from the core's pure functions (the `markstay` package); this package adds only
the mdast glue.

**Child-block identity (§5.5) is not implemented here.** Version 1.3 lets a direct list
item carry its own stay under the reserved `subhash` key, and §16 makes segmenting and
resolving those **optional**. What §16 makes mandatory for every tool is the write-path
shim, which this package honours: a `subhash` marker is preserved verbatim, never given
a container hash, and never counted as its block's stay. The Python reference implements
the section itself.

## Install

```sh
npm install remark-stay
```

Pulls in `markstay` (the core) plus `unified` / `remark-parse` /
`unist-util-visit` / `mdast-util-to-markdown`. `remark-mdx` is optional (only
needed to detect markers in MDX expression nodes). Requires Node >= 22.

## Three structural wins from working on the tree

- **mdast is SPEC §5.2 for free.** A `list`, `code` fence, or `blockquote` is one
  node regardless of internal blank lines, so the whole-block attachment the
  string core's blank-line segmenter splits (loose lists, blank-line fences) is
  just "the marker binds the preceding block node." No separate segmenter.
- **A marker-shaped comment inside a fence is correctly ignored.** It is part of
  the `code` node's literal value, not a separate `html` node, so the tree never
  mistakes it for a marker. SPEC.md §3.3 (v1.5) makes that the rule for every
  reader, and the string core reaches it from a line-based fence mask; the tree
  had it for free from the start.
- **Intra-pipeline §11: a transform that drops a stay is caught.** Inside a
  unified pipeline a later transform can mutate or remove a node carrying a stay.
  Snapshot the §9 anchors at parse time (source-slice hashes are only valid then),
  run the §11 diff + §9.1 resolve against the re-parsed pipeline output, and a
  silently dropped stay surfaces as `DROPPED_ID` while a moved one keeps its
  identity. The string core, with no pipeline visibility, structurally can't offer
  this. See `examples/transform-safety.mjs` (runnable; exits non-zero on a drop).

## Leading YAML frontmatter, and why it does not need `remark-frontmatter`

Leading YAML frontmatter is document metadata, not a block (SPEC.md §5.3): it is
never a block, never stamped, and never hashed, so a metadata-only edit
(`status: draft` -> `status: done`) does not read as a content edit.

The string core blanks the span before segmenting. An adapter is handed a tree
someone else parsed and cannot rewrite the source, so `frontmatter.js` computes the
same span in **source offsets** and drops the nodes inside it. Recognizing the span
from the source rather than from a node type is what makes the adapter agree with
itself with and without `remark-frontmatter` in the pipeline: with the plugin the
metadata is one `yaml` node, without it the same bytes are a `thematicBreak` plus a
setext `heading`, and both fall inside the same span. **No peer dependency on
`remark-frontmatter`, and no behaviour change when it is present.**

The recognition rule is the core's, verbatim, and it is conservative because `---`
is also a thematic break and a setext underline. A span counts only when line 1 is
exactly `---`, a later line is exactly `---` or `...`, the payload between them is
non-empty with no blank line, and at least one payload line is unambiguously YAML (a
`key:` or a `- item`). A YAML *comment* does not count, since `# x` is also an ATX
heading. "Unambiguously YAML" is judged with ASCII whitespace, as everywhere else in
the spec (§8/§9): the runtimes' own Unicode whitespace sets disagree with each other,
and a rule that DELETES a span must not vary by implementation. The conditions
confine the ambiguity rather than removing it: a blank-free payload that reads as
YAML is *also* ordinary Markdown, whether it is a sequence (`---` / `- Keep this` /
`---`, a list between two thematic breaks) or a mapping (`---` / `title: v` / `---`,
a setext heading under one). Frontmatter wins in both, as it does in every mainstream
site generator; outside that shape everything fails towards "ordinary Markdown".

Two consequences worth knowing:

- **A node straddling the closing fence keeps its content half.** `...` is a legal
  YAML end marker but not a setext underline, so `---` / `title: t` / `...` /
  `Body.` parses as one paragraph that starts inside the metadata and ends outside
  it. The adapter trims the metadata half rather than dropping the node, because
  dropping it would silently destroy `Body.`
- **`remark-frontmatter` is more permissive than §5.** It accepts a payload
  containing a blank line, which §5 rejects (that rejection is what stops two
  thematic breaks around a paragraph from swallowing the paragraph). With the plugin
  loaded, such a span arrives as one `yaml` node and the adapter treats it as an
  ordinary content block: nothing is lost, but the segmentation differs from the
  string core there, as it does for any node the parser groups differently. Pinned
  by a test rather than left to be discovered.

## Layout

```
src/
  attach.js     §5.2 tree attachment: mdast -> the core's content-block list
                (the only genuinely new logic), + the public `attach` view
  lint.js       lint / diff / resolve over the tree, each delegating to the
                core's block-level functions (single-sourced algorithms)
  serialize.js  drift-only serialize hash (NON-normative; see below)
  plugin.js     the unified plugin (vfile messages, file.data.stay, options)
  frontmatter.js  §5 leading-frontmatter span, by source offsets (see below)
  index.js      public API
test/
  parity.test.js        the shared corpus (conformance/) through the tree,
                        asserting tree == string core on the §5.2-agreeing subset
  tree-vectors.test.js  the §5.2-only tier (conformance/tree/) + the two
                        intended divergences
  plugin.test.js        plugin behaviour (annotate / lint / baseline / fail / mdx)
  transform-safety.test.js  intra-pipeline §11: a dropped stay is caught and
                            fatal under `fail`; a survivor still resolves
examples/
  transform-safety.mjs  runnable transform-safety demo (see structural wins above)
```

## Public API

Default export: the `remarkStay` unified plugin.

```js
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStay from "remark-stay";
import { VFile } from "vfile";

const proc = unified()
  .use(remarkParse)
  .use(remarkStay, { mode: "both", mdx: false, baseline: priorSource, fail: false });

const file = new VFile({ value: markdown });
await proc.run(proc.parse(markdown), file); // .run(), not .process() — inspecting needs no stringifier

file.data.stay; // { stays: [{ id, hash, drift, line, blockType }], findings, diff?, resolutions? }
file.messages;  // MALFORMED_MARKER / ORPHAN_MARKER / DUPLICATE_ID / HASH_DRIFT / DROPPED_ID / RELOCATED_ID ...
```

> Use `.run()` to inspect `file.data.stay`. To write the annotated Markdown back
> out (annotate mode), add a serializer, `.use(remarkStringify)`, and call
> `.process()` instead.

Options: `mode` (`'lint' | 'annotate' | 'both'`, default `both`), `mdx` (detect
`{/* stay: */}` expression nodes; needs `remark-mdx` upstream), `baseline` (a
prior Markdown string or `{ tree, source }`, runs the §11 diff + §9.1 ladder),
`fail` (mark error-level findings fatal to gate a build).

Named exports (tree building blocks; each takes `(tree, source)` where `source`
is the exact Markdown the tree was parsed from):

`attach`, `extractBlocks`, `lintTree`, `diffTrees`, `anchorsFromTree`,
`resolveTree`, `serializeHash`, `sortFindings`, `bodyHash`.

## Hashing: source-slice is normative, serialize is drift-only

Two ways to get a block's body from the tree:

- **Source-slice (normative):** slice the original source by the node's
  `position` offsets, cut the marker spans, hash with the core's `bodyHash`. This
  is **byte-identical to the string core's digest** on the §5.2-agreeing subset ,
  the cross-implementation §8 parity guarantee. The one exception left is
  marker-shaped *literal text inside an inline `` `...` `` span*: the tree leaves
  it in the body, while the string core's raw scan strips it. SPEC.md §3.3 settled
  the fenced half of that gap in v1.5 and declines inline spans on purpose, so the
  two segmenters now agree on a fence and still diverge inside backticks; both
  behaviours are pinned in `conformance/tree/`. Used for annotate/lint.
- **Serialize (`serializeHash`, drift-only):** after a transform mutates the tree
  (positions stale), re-serialize the node and hash that. remark's serializer
  normalizes syntax (setext -> ATX headings, fence info, bullet style), so this is
  **not** the cross-impl digest , only a "did this block drift in the pipeline?"
  signal. Never use it for conformance.

## Running the tests

Requires Node >= 22.

```sh
npm install
node --test          # or: npm test
```

> Pass no path argument: `node --test` auto-discovers `test/*.test.js` (a bare
> directory arg is not expanded on Node 22).

`remark-frontmatter` is not installed here, so the two tests that characterize the
plugin **skip**: one proves the frontmatter span is recognized identically with and
without it, the other pins the documented corner where the plugin's more permissive
rule keeps a span §5 rejects. Add it (`npm i -D remark-frontmatter`) to run them. The published package depends on it in
no form, in either direction.

`markstay` resolves to the released core (`>=0.8.0 <1.0.0`), which is where the
frontmatter span rule itself lives; this adapter reimplements it in source offsets
rather than duplicating the rule. The range is deliberately wider than a caret: the
family shares one version number, so a core release reaches you without this adapter
republishing.

## Conformance: the third sentinel

`parity.test.js` feeds the shared corpus (`conformance/`, `spec/` + `gen/`)
through the tree adapter and asserts its blocks, findings, hashes, diffs, and
resolutions equal the string core's on the §5.2-agreeing subset (MDX vectors go
through the `remark-mdx` pipeline). It joins the Python reference and the JS core
([`markstay`](https://github.com/markstaymd/markstay-core)) as the third
cross-impl regression sentinel: any change that breaks agreement fails one of the
three.

A corpus vector is skipped there when it holds a **thematic break touching
content** (`---` / `Title` / `---` and friends), which is outside §5's stated
agreement subset for a reason that has nothing to do with lists or fences:
blank-line segmentation cannot see that the `---` is its own block. Those vectors
exist to pin the guards on the frontmatter rule across the three string
implementations, so the skip is by predicate, not by a list of names that would go
stale. A recognized frontmatter span is cut before the predicate runs, since both
segmenters skip it and therefore do agree on it.

The **§5.2-only tier** (`conformance/tree/`) is consumed only here (the string
runners would fail it by design). It pins both segmenters and their relationship
on the cases where the tree adds value:

| vector | relation | what it pins |
|--------|----------|--------------|
| loose-list-one-block        | diverges | tree binds the whole loose list; baseline splits per item |
| blank-line-fence-one-block  | diverges | tree keeps the fence whole; baseline splits at the blank line |
| marker-in-fence-ignored     | agrees   | neither segmenter reads a comment inside a fenced code block as a marker (§3.3) |
| marker-in-inline-code-ignored | diverges | tree ignores a comment inside an inline `` `code` `` span; baseline detects it |
| blockquote-internal-blank   | agrees   | a `>`-prefixed line isn't blank, so §5.2 adds nothing here |
| frontmatter-skipped         | agrees   | leading YAML metadata is not a block in either segmenter |
| frontmatter-dots-closer-straddle | agrees | a node straddling a `...` closer keeps its content half |
| frontmatter-marker-after-fence-is-an-orphan | agrees | a pre-existing frontmatter marker fails loudly, not silently |
| leading-thematic-break-not-frontmatter | agrees | a blank line in the payload means it was never frontmatter |
| setext-heading-under-leading-break | diverges | not frontmatter either; they then split for the ordinary §5-vs-§5.2 reason |

The intended divergences from the string core (marker-shaped text inside an inline
code span, and source-slice vs serialize hash) also have dedicated assertions in
`tree-vectors.test.js`, which since v1.5 additionally pins the fenced case as an
*agreement*, alongside regressions for the mixed-HTML-block case and
the positionless-node guard.

## License

MIT
