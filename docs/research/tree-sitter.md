# Tree-sitter grammar pipeline for JavaScript and TypeScript

**Research ticket:** [Verify the Tree-sitter grammar pipeline](https://github.com/spiritledsoftware/antisprawl/issues/3)

**Snapshot:** 2026-09-14. Sources were fetched at the commits linked below; registry and query repositories are moving inputs, so the exact commits must be recorded by Antisprawl rather than following `main` at parse time.

## Conclusion

The accepted architecture is feasible, but the Neovim Tree-sitter registry is a **catalogue, not a lockfile or WASM distribution**. It supplies parser/query repository locations and discovery hints. Antisprawl needs its own resolved grammar record containing the registry commit, parser commit, query commits, inherited-query commits, asset digests, Tree-sitter/WebAssembly runtime version, and ABI. It also needs a trusted source for generated parser WASM; the registry does not provide one.

The supported runtime shape is:

1. Resolve and validate the registry and query manifests.
2. Resolve exact parser and query commits, including query inheritance, and record them.
3. Obtain a parser `.wasm` artifact generated from that parser commit (prefer a release asset; otherwise produce it in a trusted build pipeline, not in the end-user executable).
4. Verify size and SHA-256 against Antisprawl's resolved artifact manifest, then cache atomically under a key containing all provenance.
5. Embed the `web-tree-sitter` core WASM in the Bun executable and pass its bytes explicitly to `Parser.init({ wasmBinary })`. Do not rely on the binding's default WASM path in a compiled executable.
6. Load grammar bytes with `Language.load(Uint8Array)`, check the parser ABI, parse fixtures, then run Antisprawl's own symbol query. The Neovim query repositories are useful compatibility/query inputs, but they do not define Antisprawl's symbol-record contract.

## What the registry actually provides

The registry's own README says it is plain JSON, that entries locate parser and query sources, that installers choose the version-discovery API, and that the registry intentionally does not pin parser revisions ([README at commit `6eb15358`](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/README.md#L40-L54), [design statement](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/README.md#L80-L84)). Its JSON Schema validates registry entries and query-repository `parser.json` manifests, but has no parser-WASM URL or digest field ([schema](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/schemas/schema.json#L28-L91), [external-query fields](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/schemas/schema.json#L121-L132)).

At the registry commit `6eb15358bb9fc88f0d3401d8538d56652e9bdf3c`:

| Language   | Registry source                      | Parser location | Parser discovery       | Query discovery                                              | Required query dependencies |
| ---------- | ------------------------------------ | --------------- | ---------------------- | ------------------------------------------------------------ | --------------------------- |
| JavaScript | `tree-sitter/tree-sitter-javascript` | root            | `parser_semver: false` | `nvim-treesitter-queries-javascript`, `queries_semver: true` | `ecma`, `jsx`               |
| TypeScript | `tree-sitter/tree-sitter-typescript` | `typescript`    | `parser_semver: false` | `nvim-treesitter-queries-typescript`, `queries_semver: true` | `ecma`                      |
| TSX        | `tree-sitter/tree-sitter-typescript` | `tsx`           | `parser_semver: false` | `nvim-treesitter-queries-tsx`, `queries_semver: true`        | `ecma`, `jsx`, `typescript` |

See the exact [JavaScript entry](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/registry.json#L1630-L1645), [JSX query-only entry](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/registry.json#L1748-L1756), [TSX entry](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/registry.json#L3611-L3627), and [TypeScript entry](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/registry.json#L3653-L3668).

The registry's architecture document describes `parser_version` as the exact parser checkout target when it is present, and says query inheritance is expressed by `; inherits:` directives and merged recursively ([manifest fields](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/docs/architecture.md#L98-L152), [inheritance algorithm](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/docs/architecture.md#L207-L226)). The document also says the semver flags guide automated bumping; they are not installer pins ([version discovery](https://github.com/neovim-treesitter/treesitter-parser-registry/blob/6eb15358bb9fc88f0d3401d8538d56652e9bdf3c/docs/architecture.md#L154-L177)).

## Exact current JS/TS resolution

The current query manifests provide the parser refs that queries were tested against:

| Language/query repo    | Query repo commit                                                                                                                   | `parser.json` parser ref                                                                                          | Parser source location |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- |
| JavaScript             | [`60cc37d9`](https://github.com/neovim-treesitter/nvim-treesitter-queries-javascript/tree/60cc37d9acbb83b7a8b988a6221920806ac648e6) | [`58404d8c`](https://github.com/tree-sitter/tree-sitter-javascript/tree/58404d8cf191d69f2674a8fd507bd5776f46cb11) | root                   |
| TypeScript             | [`a0659042`](https://github.com/neovim-treesitter/nvim-treesitter-queries-typescript/tree/a0659042394b37f5b952b57574e8bd79dc4aa20d) | [`75b3874e`](https://github.com/tree-sitter/tree-sitter-typescript/tree/75b3874edb2dc714fb1fd77a32013d0f8699989f) | `typescript`           |
| TSX                    | [`35593fbb`](https://github.com/neovim-treesitter/nvim-treesitter-queries-tsx/tree/35593fbb9fa4bf384108d5dfa4e27e57a6025443)        | [`75b3874e`](https://github.com/tree-sitter/tree-sitter-typescript/tree/75b3874edb2dc714fb1fd77a32013d0f8699989f) | `tsx`                  |
| ECMA inherited queries | [`463d2e55`](https://github.com/neovim-treesitter/nvim-treesitter-queries-ecma/tree/463d2e55597e7328334a1b46a2a8378cb75132b4)       | query-only; host parser is JavaScript                                                                             | n/a                    |
| JSX inherited queries  | [`d0018224`](https://github.com/neovim-treesitter/nvim-treesitter-queries-jsx/tree/d001822416e222101414aac94c59d8c2c2e035a3)        | query-only; host parser is JavaScript                                                                             | n/a                    |

The parser manifests are [JavaScript](https://github.com/neovim-treesitter/nvim-treesitter-queries-javascript/blob/60cc37d9acbb83b7a8b988a6221920806ac648e6/parser.json), [TypeScript](https://github.com/neovim-treesitter/nvim-treesitter-queries-typescript/blob/a0659042394b37f5b952b57574e8bd79dc4aa20d/parser.json), and [TSX](https://github.com/neovim-treesitter/nvim-treesitter-queries-tsx/blob/35593fbb9fa4bf384108d5dfa4e27e57a6025443/parser.json). Their `.scm` files contain these inheritance directives:

- JavaScript inherits `ecma` and `jsx` for most query groups, and `ecma` for locals.
- TypeScript inherits `ecma`.
- TSX inherits `typescript` and `jsx` (and TypeScript itself inherits `ecma`).

The query-only manifests identify JavaScript as the host parser and do not pin a separate parser ([ECMA manifest](https://github.com/neovim-treesitter/nvim-treesitter-queries-ecma/blob/463d2e55597e7328334a1b46a2a8378cb75132b4/parser.json), [JSX manifest](https://github.com/neovim-treesitter/nvim-treesitter-queries-jsx/blob/d001822416e222101414aac94c59d8c2c2e035a3/parser.json)).

**Important current constraint:** despite the registry's `queries_semver: true`, `git ls-remote --tags --refs` returned no tags for these five query repositories on 2026-09-14. The installer must not assume a semver tag exists. Resolve a query ref to a commit SHA (currently the heads above), validate `parser.json`, and store that SHA. A future tag can be used only after resolving it to a SHA and recording the result.

## Obtaining and verifying parser WASM

The official `web-tree-sitter` README supports three practical sources for language WASM: npm packages, GitHub releases that publish WASM, or generation with `tree-sitter build --wasm` ([README](https://github.com/tree-sitter/tree-sitter/blob/1b8407d1e718f2a26e2886c03cc55622d8d1d7bd/lib/binding_web/README.md#L151-L194)). The official reusable release workflow builds each grammar with `tree-sitter build --wasm`, uploads `*.wasm`, and creates build-provenance attestations ([workflow](https://github.com/tree-sitter/workflows/blob/10c66d66e558b37df92e2a8ec5321218a6547b04/.github/workflows/release.yml#L46-L89)).

This does **not** solve arbitrary registry revisions:

- JavaScript and TypeScript are currently `parser_semver: false`; the query manifests pin untagged commits (`58404d8c` and `75b3874e`). A release asset for `v0.25.0` or `v0.23.2` is not proof that it was generated from those exact commits.
- The registry has no WASM asset URL or digest. A Git commit pins source, not the generated binary; generation can vary with the Tree-sitter CLI, WASI SDK, and ABI setting.
- The end-user executable must not download a compiler or run arbitrary grammar JavaScript. Generation belongs in a trusted release/build job, or an explicitly controlled offline preparation step.
- npm package versions are not a substitute for parser commit pins unless package metadata or a project-owned manifest proves the exact source commit and artifact digest.

Therefore the resolver needs a project/release-owned grammar artifact manifest, for example:

```json
{
  "registryCommit": "6eb15358...",
  "language": "javascript",
  "parserUrl": "https://github.com/tree-sitter/tree-sitter-javascript",
  "parserCommit": "58404d8...",
  "parserLocation": ".",
  "wasmUrl": "https://.../tree-sitter-javascript.wasm",
  "wasmSha256": "...",
  "wasmBuild": { "treeSitterCli": "...", "abi": 15 },
  "queryRepo": "https://github.com/neovim-treesitter/nvim-treesitter-queries-javascript",
  "queryCommit": "60cc37d9...",
  "inheritedQueryCommits": { "ecma": "463d2e55...", "jsx": "d0018224..." },
  "querySha256": "..."
}
```

The manifest itself should be pinned/signed with the release or project configuration. On download, restrict hosts/sources, enforce a maximum byte size, calculate SHA-256 before promotion, and atomically rename a complete verified cache entry. Parser WASM is executable input; parsing must remain resource-bounded. Cache keys should include language, parser/query revisions, runtime/ABI version, and all asset digests, as required by the accepted architecture.

## Loading in Bun and compiled executables

`web-tree-sitter` exposes `Parser.init(moduleOptions)`, `Language.load(string | URL | Uint8Array)`, and `Language.loadSync(WebAssembly.Module)` ([`Parser.init`](https://github.com/tree-sitter/tree-sitter/blob/1b8407d1e718f2a26e2886c03cc55622d8d1d7bd/lib/binding_web/src/parser.ts#L108-L118), [`Language.load`](https://github.com/tree-sitter/tree-sitter/blob/1b8407d1e718f2a26e2886c03cc55622d8d1d7bd/lib/binding_web/src/language.ts#L229-L283)). Bun's official executable documentation says `with { type: "file" }` embeds a file, returns an internal path, and that `Bun.file(path).arrayBuffer()` reads embedded binary assets; it gives a WASM example ([Bun executable asset docs](https://bun.sh/docs/bundler/executables#embed-assets-files)).

Use this shape in the compiled entrypoint:

```ts
import corePath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import { Parser, Language } from "web-tree-sitter";

const coreBytes = new Uint8Array(await Bun.file(corePath).arrayBuffer());
await Parser.init({ wasmBinary: coreBytes });

const grammarBytes = new Uint8Array(await Bun.file(grammarPath).arrayBuffer());
const language = await Language.load(grammarBytes);
```

For lazy grammar installation, `grammarPath` is a verified cache path. For a development or release smoke test, it can be another `type: "file"` asset. Passing bytes avoids filesystem/URL differences and avoids making the parser binding discover an asset path inside Bun's virtual filesystem.

I verified this behavior with Bun 1.4.2 on Linux x64, `web-tree-sitter` 0.27.0, and parser WASM generated from the current JavaScript (`58404d8c`) and TypeScript (`75b3874e`) sources:

- A compiled executable using plain `Parser.init()` failed with `ENOENT: ... '/$bunfs/root/web-tree-sitter.wasm'`.
- A compiled executable using an embedded core WASM file and `Parser.init({ wasmBinary })` succeeded.
- The same executable loaded embedded JavaScript and TypeScript grammar bytes with `Language.load(Uint8Array)` and parsed fixtures successfully.
- The observed language ABIs were JavaScript 15 and TypeScript 14; the core binding accepted both.

This is an exact unsupported assumption to encode in acceptance tests: **Bun embedding a `.wasm` file does not make `Parser.init()`'s default Emscripten lookup reliable. Explicit `wasmBinary` is required.**

The `web-tree-sitter` compatibility table says versions `>=0.25.0` support parser ABI 13 through 15 and warns that some older prebuilt WASM uses a dynamic-linking format newer bindings cannot load ([compatibility warning](https://github.com/tree-sitter/tree-sitter/blob/1b8407d1e718f2a26e2886c03cc55622d8d1d7bd/lib/binding_web/README.md#L196-L207)). Pin the core binding version, check `Language.abiVersion`/`Parser.setLanguage`, and parse at least one fixture per grammar. Do not treat a successful `WebAssembly.validate` as sufficient compatibility proof.

## Symbol-query boundary

The registry's Neovim query repositories are editor queries (`highlights.scm`, `locals.scm`, `folds.scm`, `indents.scm`, and `injections.scm`), not an Antisprawl symbol-extraction API. Their JavaScript/ECMA queries do contain useful captures such as `@function` and `@function.method`, but they capture different nodes for declarations, methods, and arrow-function assignments. They do not promise Antisprawl's common Symbol record, qualified-name rules, ranges, or meaningful-size behavior.

The accepted architecture therefore needs a **separate Antisprawl-owned symbol query per grammar**, tested against the exact pinned grammar. It may borrow node patterns from the registry queries or the parser repositories' `tags.scm`, but it must not silently treat Neovim highlight captures as the detector contract. A query can compile successfully while its predicates or capture semantics differ between Neovim and `web-tree-sitter`; use only predicates supported by the selected binding, or keep the symbol query deliberately simple and validate its captures end-to-end.

## Recommended resolver/cache sequence

1. Fetch the registry JSON and schema over HTTPS, record the registry commit/digest, and validate before reading entries.
2. Resolve JavaScript/TypeScript/TSX entries and dependencies. Fetch each query repo at a resolved commit, validate `parser.json`, and recursively resolve `; inherits:` files with cycle detection.
3. Require exact parser refs from manifests when present. Resolve any remaining `HEAD`/tag discovery to a SHA immediately; never persist `latest`, a branch name, or an unqualified tag.
4. Resolve a parser WASM artifact from the project-owned artifact manifest. Reject an artifact whose parser SHA, location, ABI, digest, or language identity does not match.
5. Download query files and WASM to temporary files, enforce size limits, hash them, and atomically promote the complete metadata-plus-assets directory into a platform user cache. Concurrent installers need a lock or equivalent single-writer protocol.
6. Load the core binding with explicit embedded `wasmBinary`; load grammar bytes from cache; check ABI and parse fixtures.
7. Compile/run the Antisprawl symbol query. Reject or visibly skip a grammar when any query/fixture/error-node acceptance check fails; do not guess a language mapping.
8. Persist all resolved provenance in project configuration/index metadata. Existing pins must not follow registry or upstream `HEAD`; an explicit grammar update operation creates a new resolution.

## Unsupported assumptions and follow-up decisions

- **Registry implies a downloadable WASM asset:** false. Add an artifact manifest/release pipeline or narrow the runtime support to grammar assets Antisprawl publishes itself.
- **`parser_semver: false` can use the latest parser release:** false. It means the source tracks default-branch HEAD; use the exact query-manifest SHA and build/obtain matching WASM.
- **`queries_semver: true` guarantees tags:** false for the current JS/TS query repositories; resolve and record commit SHAs.
- **A parser commit alone verifies generated WASM:** false. Verify a trusted artifact digest and record generation toolchain/ABI.
- **The registry's query files are Antisprawl's symbol query:** false. Own and test symbol extraction queries.
- **Bun `--compile` automatically makes `Parser.init()` find its core WASM:** false; pass `wasmBinary` explicitly.
- **WASM ABI compatibility guarantees query compatibility:** false. ABI checks and query compilation/fixture extraction are separate acceptance gates.

These constraints should feed the vertical-slice contract and acceptance-matrix tickets. No product code was changed by this research.
