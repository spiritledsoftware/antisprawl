# Effect v4 on compiled Bun

Research for [issue #2](https://github.com/spiritledsoftware/antisprawl/issues/2), performed 2026-09-14 against Bun 1.4.2 and Effect `4.0.0-beta.107`. This is a compatibility report, not a product implementation. No product source or dependency manifest was changed.

## Result

**Effect beta.107 runs in a Bun-compiled executable.** The small proof programs exercised the CLI, schema decoding, layers/scopes, a custom embedding provider, and `@effect/sql-sqlite-bun`; each ran under Bun and after `bun build --compile`. A failure exits with status 1 and SIGTERM interruption exits with status 130. TypeScript checking also passed.

The useful architecture is a thin Effect boundary around untrusted input, resources, and provider calls:

```text
Bun entrypoint
  -> BunRuntime.runMain
  -> Command.runWith + BunServices.layer
  -> Schema.decodeUnknownEffect at input boundaries
  -> domain code (ordinary TypeScript)
  -> provider/SQLite Layers, scoped with Effect.scoped
```

Keep the lockfile strict (including transitive Effect packages) and run `bun:sqlite` integration tests under Bun rather than the Node-based Vitest CLI.

## Version and package map

The package manifests and source below are pinned to the same upstream commit, which is the `effect@4.0.0-beta.107` tag: [`3c495ae7`](https://github.com/Effect-TS/effect/tree/3c495ae7c96d43bfc3b8020250562a194c2c895e).

| Need                                  | Package/API                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core effects, layers, scopes, schemas | `effect@4.0.0-beta.107`                   | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/package.json), [Layer](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Layer.ts), [Scope](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Scope.ts), [Schema](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Schema.ts) |
| Bun runtime/services                  | `@effect/platform-bun@4.0.0-beta.107`     | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-bun/package.json), [`BunRuntime.ts`](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-bun/src/BunRuntime.ts), [`BunServices.ts`](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-bun/src/BunServices.ts)                                                                                    |
| SQLite through `bun:sqlite`           | `@effect/sql-sqlite-bun@4.0.0-beta.107`   | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/sql/sqlite-bun/package.json), [`SqliteClient.ts`](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/sql/sqlite-bun/src/SqliteClient.ts)                                                                                                                                                                                                                                      |
| Effect-aware Vitest helpers           | `@effect/vitest@4.0.0-beta.107`           | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/vitest/package.json), [index](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/vitest/src/index.ts)                                                                                                                                                                                                                                                                         |
| OpenAI embedding adapter              | `@effect/ai-openai@4.0.0-beta.107`        | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/ai/openai/package.json), [embedding model](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/ai/openai/src/OpenAiEmbeddingModel.ts)                                                                                                                                                                                                                                          |
| OpenAI-compatible embedding adapter   | `@effect/ai-openai-compat@4.0.0-beta.107` | [manifest](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/ai/openai-compat/package.json), [embedding model](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/ai/openai-compat/src/OpenAiEmbeddingModel.ts)                                                                                                                                                                                                                            |

The publisher's registry metadata exposes exact `4.0.0-beta.107` versions for [effect](https://registry.npmjs.org/effect/4.0.0-beta.107), [platform-bun](https://registry.npmjs.org/@effect%2Fplatform-bun/4.0.0-beta.107), [sqlite-bun](https://registry.npmjs.org/@effect%2Fsql-sqlite-bun/4.0.0-beta.107), [ai-openai](https://registry.npmjs.org/@effect%2Fai-openai/4.0.0-beta.107), [ai-openai-compat](https://registry.npmjs.org/@effect%2Fai-openai-compat/4.0.0-beta.107), and [vitest](https://registry.npmjs.org/@effect%2Fvitest/4.0.0-beta.107). Published exports are ESM `dist` files. `effect` exports `effect/unstable/cli` and `effect/unstable/ai`; `platform-bun` exports `BunRuntime` and `BunServices`.

## Runtime, CLI, schema, and resource behavior

- `BunRuntime.runMain` is the Bun entrypoint and re-exports the platform-node-shared `NodeRuntime.runMain` implementation ([source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-bun/src/BunRuntime.ts), [NodeRuntime](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-node-shared/src/NodeRuntime.ts), [runtime core](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Runtime.ts)). It forks the main fiber, reports failures by default, handles SIGINT/SIGTERM interruption, and tears down resources. The observed/default statuses are 0 for success, 1 for failure, and 130 for interruption. Beta options are `disableErrorReporting` and `teardown`; do not copy options that only exist in newer release-candidate docs.
- The beta CLI API is lowercase: `Flag.string`, `Flag.boolean`, and `Flag.integer` ([Flag source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Flag.ts)). `Command.make` and `Command.runWith` produce typed Effects ([Command source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Command.ts)). The command environment requires `FileSystem`, `Path`, `Terminal`, `ChildProcessSpawner`, and `Stdio`; `BunServices.layer` supplies those platform services.
- `Layer` is typed dependency construction with memoization and scope ([Layer source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Layer.ts)). Scope owns finalizers ([Scope source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Scope.ts)); `Effect.scoped` closes the scope, so database/provider resources should be acquired and released there rather than by ad-hoc shutdown code.
- Decode external values with `Schema.decodeUnknownEffect` so invalid data is a `SchemaError` in the Effect error channel; `decodeUnknownSync` throws for synchronous callers ([Schema source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/Schema.ts)). Keep pure domain modules as ordinary TypeScript and put schemas at trust boundaries.

## Embeddings and provider adapters

`EmbeddingModel.make` accepts an Effectful provider function (`embedMany({ inputs })`), retains input order and usage metadata, validates that the provider returns one vector per input, and fails invalid output with `AiError.InvalidOutputError` ([source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/ai/EmbeddingModel.ts)). The OpenAI and OpenAI-compatible packages expose model/layer adapters and imported successfully in the Bun proof. This check made no network requests and required no credentials; it verifies packaging and wiring only.

## SQLite on Bun

`@effect/sql-sqlite-bun` imports Bun's native `bun:sqlite` and exposes a scoped `SqliteClient.layer(config)` that supplies the generic `SqlClient` ([source](https://raw.githubusercontent.com/Effect-TS/effect/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/sql/sqlite-bun/src/SqliteClient.ts)). The beta implementation:

- enables WAL by default;
- uses a five-second busy timeout (a synchronous wait, so contention blocks the event loop);
- serializes client access and uses `BEGIN IMMEDIATE` for transactions;
- supports database export and extension loading;
- does not implement streaming or `updateValues`.

An in-memory database was created, queried, and closed both in Bun and in the compiled executable. Bun's own SQLite documentation is [here](https://bun.sh/docs/runtime/sqlite). Treat file database paths as CWD-relative in a compiled application unless the application deliberately resolves an absolute path.

## Tests and test-runner boundary

`@effect/vitest@4.0.0-beta.107` accepts Vitest `>=4.1.0 <5.0.0`, so the repository's Vitest `4.1.11` is in range. It exports `it.effect`, `it.live`, `it.layer`, `it.prop`, and `it.flakyTest`; the Effect tests are scoped and the temporary layer/finalizer tests passed.

The normal Vitest CLI is Node-based. A test that imported `@effect/sql-sqlite-bun` failed under Node because Node cannot resolve the `bun:` URL. Keep pure Effect tests in `@effect/vitest`; run SQLite integration checks through Bun (or a Bun-capable test harness), including the compiled executable path that production uses.

## Lockfile constraint

The important failure was not Bun compilation. With Bun 1.4.2 and direct Effect packages pinned to beta.107, the published `@effect/platform-bun` dependency range (`@effect/platform-node-shared: ^4.0.0-beta.107`) allowed resolution of `@effect/platform-node-shared@4.0.0-rc.115`. Import then failed because the RC implementation expected `effect/ByteSize`, which is absent from beta.107. Adding an exact `@effect/platform-node-shared@4.0.0-beta.107` pin and using a frozen lockfile fixed the import.

**Recommendation:** pin every Effect-family package in the dependency graph to one exact release, inspect the lockfile on every upgrade, and upgrade the family atomically. Do not rely on a caret range spanning beta and RC builds.

## Bun compilation checks

The proof used Bun 1.4.2 and `bun build --compile`. CLI/schema, custom embedding, and SQLite programs passed in both interpreted and compiled modes. Cross-compilation also succeeded for the targets needed by this project: Linux arm64, macOS arm64, and Windows x64 (the generated files identified as ELF aarch64, Mach-O arm64, and PE x64). Bun documents executable bundling and targets at [bun.sh/docs/bundler/executables](https://bun.sh/docs/bundler/executables).

`--compile` bundles imported files/packages and the Bun runtime, including `bun:sqlite`. It does not automatically make arbitrary runtime assets available: dynamic grammar WASM or native SQLite extensions need explicit assets or an extraction/loading path. Bun also documents that `package.json` and `tsconfig.json` loading is disabled by default for compiled executables, while `.env` and `bunfig.toml` loading is enabled by default. Make runtime configuration explicit rather than depending on a source-tree working directory.

Minimal verification shape:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun build --compile src/main.ts --outfile dist/app
./dist/app --help
./dist/app --invalid-input; test $? -eq 1
bun build --compile --target=bun-linux-arm64 src/main.ts --outfile /tmp/app-linux-arm64
bun build --compile --target=bun-darwin-arm64 src/main.ts --outfile /tmp/app-darwin-arm64
bun build --compile --target=bun-windows-x64 src/main.ts --outfile /tmp/app.exe
```

The final three commands validate artifact creation only on the host; execute each artifact on its target OS/architecture in CI or release validation.

## Decision map

| Area             | Decision for this repository                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Entrypoint       | Use `BunRuntime.runMain` for the top-level Effect.                                                                                     |
| CLI              | Use beta.107 lowercase `Flag.*` API and `Command.runWith`, layered with `BunServices.layer`.                                           |
| Input validation | Schema at CLI/file/provider boundaries; ordinary TypeScript for trusted pure domain logic.                                             |
| Resources        | Compose Layers and close them with `Effect.scoped`.                                                                                    |
| Embeddings       | Depend on `EmbeddingModel`; keep OpenAI adapter selection in a layer.                                                                  |
| SQLite           | Use `@effect/sql-sqlite-bun` only from Bun execution paths; account for synchronous contention and unsupported streaming/updateValues. |
| Tests            | Use `@effect/vitest` for pure Effect behavior; execute `bun:sqlite` checks under Bun/compiled Bun.                                     |
| Releases         | Exact-lock the Effect family; compile and smoke-test each target artifact.                                                             |

## Primary references

1. Effect beta source tag: [`3c495ae7c96d43bfc3b8020250562a194c2c895e`](https://github.com/Effect-TS/effect/tree/3c495ae7c96d43bfc3b8020250562a194c2c895e), with file links inline above.
2. npm registry exact-version metadata, linked in the package map above.
3. [Bun executable bundling and compilation](https://bun.sh/docs/bundler/executables).
4. [Bun SQLite runtime API](https://bun.sh/docs/runtime/sqlite).
