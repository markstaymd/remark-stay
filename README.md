# remark-stay , mdast/remark adapter for markstay

[![npm](https://img.shields.io/npm/v/remark-stay)](https://www.npmjs.com/package/remark-stay)
[![bundle size](https://img.shields.io/bundlephobia/minzip/remark-stay)](https://bundlephobia.com/package/remark-stay)
[![tests](https://img.shields.io/github/actions/workflow/status/markstaymd/remark-stay/test.yml?label=tests)](https://github.com/markstaymd/remark-stay/actions/workflows/test.yml)
[![spec](https://img.shields.io/badge/spec-v1.1-blue)](https://markstay.org)
![License](https://img.shields.io/npm/l/remark-stay)

The **integration surface** for [markstay](https://markstay.org) in the
JavaScript Markdown/MDX pipeline ecosystem. The parser-free core (the
[`markstay`](https://www.npmjs.com/package/markstay) package) validates the spec
at the string level; this adapter drops markstay into the pipelines where the use
cases live (MDX, Astro, Next, Docusaurus, AI doc-editing), where the unit of work
is an mdast tree, not raw text.

It is the **third gated implementation** of the [markstay spec](https://markstay.org)
(v1.1), after the Python reference and the zero-dependency JS core. It does not
fork the algorithms: every hash, ratio, lint code, and resolution verdict comes
from the core's pure functions (the `markstay` package); this package adds only
the mdast glue.

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
  mistakes it for a marker , the raw-scan quirk the string core tracks as an open
  question, resolved for free by the AST.
- **Intra-pipeline §11: a transform that drops a stay is caught.** Inside a
  unified pipeline a later transform can mutate or remove a node carrying a stay.
  Snapshot the §9 anchors at parse time (source-slice hashes are only valid then),
  run the §11 diff + §9.1 resolve against the re-parsed pipeline output, and a
  silently dropped stay surfaces as `DROPPED_ID` while a moved one keeps its
  identity. The string core, with no pipeline visibility, structurally can't offer
  this. See `examples/transform-safety.mjs` (runnable; exits non-zero on a drop).

## Layout

```
src/
  attach.js     §5.2 tree attachment: mdast -> the core's content-block list
                (the only genuinely new logic), + the public `attach` view
  lint.js       lint / diff / resolve over the tree, each delegating to the
                core's block-level functions (single-sourced algorithms)
  serialize.js  drift-only serialize hash (NON-normative; see below)
  plugin.js     the unified plugin (vfile messages, file.data.stay, options)
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
  the cross-implementation §8 parity guarantee. The one exception is
  marker-shaped *literal text inside a code span* (a fenced block or an inline
  `` `...` ``): the tree leaves it in the body (correct , it is not a real
  marker), while the string core's raw scan strips it. There the tree is more
  spec-correct; both behaviours are pinned in `conformance/tree/`. Used for
  annotate/lint.
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

## Conformance: the third sentinel

`parity.test.js` feeds the shared corpus (`conformance/`, `spec/` + `gen/`)
through the tree adapter and asserts its blocks, findings, hashes, diffs, and
resolutions equal the string core's on the §5.2-agreeing subset (MDX vectors go
through the `remark-mdx` pipeline). It joins the Python reference and the JS core
([`markstay`](https://github.com/markstaymd/markstay-core)) as the third
cross-impl regression sentinel: any change that breaks agreement fails one of the
three.

The **§5.2-only tier** (`conformance/tree/`) is consumed only here (the string
runners would fail it by design). It pins both segmenters and their relationship
on the cases where the tree adds value:

| vector | relation | what it pins |
|--------|----------|--------------|
| loose-list-one-block        | diverges | tree binds the whole loose list; baseline splits per item |
| blank-line-fence-one-block  | diverges | tree keeps the fence whole; baseline splits at the blank line |
| marker-in-fence-ignored     | diverges | tree ignores a comment inside a fenced code block; baseline detects it |
| marker-in-inline-code-ignored | diverges | tree ignores a comment inside an inline `` `code` `` span; baseline detects it |
| blockquote-internal-blank   | agrees   | a `>`-prefixed line isn't blank, so §5.2 adds nothing here |

The intended divergences from the string core (marker-shaped text inside code,
and source-slice vs serialize hash) also have dedicated assertions in
`tree-vectors.test.js`, alongside regressions for the mixed-HTML-block case and
the positionless-node guard.

## License

MIT
