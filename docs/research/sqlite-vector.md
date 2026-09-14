# SQLite-Vector loading in compiled Bun executables

**Research date:** 2026-09-14  
**Ticket:** [Verify SQLite-Vector loading in compiled binaries](https://github.com/spiritledsoftware/antisprawl/issues/5)  
**Scope:** Effect `4.0.0-beta.107`, Bun SQLite, SQLite-Vector release assets, and the accepted Linux x64/arm64, macOS x64/arm64, and Windows x64 targets.

## Verdict

The design is feasible, but “load the extracted extension” is not a single unconditional capability:

- **Effect integration:** yes. `@effect/sql-sqlite-bun@4.0.0-beta.107` exposes `SqliteClient.loadExtension(path)` and delegates to `bun:sqlite`'s `Database.loadExtension(path)`.
- **Compiled executable packaging:** yes, after extraction. Bun embeds assets under a virtual `/$bunfs/...` path; native SQLite loading needs a real filesystem path. Read the embedded bytes, verify them, atomically extract them into a private versioned cache, and pass that path to `loadExtension`.
- **Linux x64:** directly verified with Bun 1.4.2, Effect beta.107, a release SQLite-Vector 1.1.2 `vector.so`, and both an ordinary script and a compiled executable.
- **Linux arm64, Windows x64, macOS x64/arm64:** source- and asset-backed, but still require target-runner acceptance tests. SQLite-Vector publishes matching native assets for all four targets.
- **macOS constraint:** Bun documents that Apple's system SQLite disables extension loading. A macOS release must also provide a compatible vanilla `libsqlite3.dylib`, extract it, and call `Database.setCustomSQLite(path)` **before the first database is opened**. The current architecture mentions embedding the SQLite-Vector library but should make this additional macOS library and signing step explicit.
- **Fallback:** the pure-Bun exact cosine scan remains necessary and is the reliable path when extension extraction/loading is unavailable.

This supports the architecture's extension strategy with the macOS packaging addition and per-target runtime tests. It does not justify making SQLite-Vector a hard requirement for indexing.

## Findings by question

### Effect adapter and transactions

The exact npm tarball [@effect/sql-sqlite-bun@4.0.0-beta.107](https://unpkg.com/@effect/sql-sqlite-bun@4.0.0-beta.107/) contains [`src/SqliteClient.ts`](https://unpkg.com/@effect/sql-sqlite-bun@4.0.0-beta.107/src/SqliteClient.ts) and declares the expected peer `effect` beta family in [`package.json`](https://unpkg.com/@effect/sql-sqlite-bun@4.0.0-beta.107/package.json).

The source establishes these facts:

- `SqliteClient` extends Effect's SQL client with `loadExtension(path): Effect<void, SqlError>`.
- The implementation opens `new Database(options.filename, ...)` from `bun:sqlite`, then implements `loadExtension` as `db.loadExtension(path)` wrapped in `Effect.try` and `SqlError` classification.
- Access is serialized through a one-permit semaphore, so extension loading and statements use the same connection safely through the client service.
- The client provides `SqlClient` and uses `BEGIN IMMEDIATE` for top-level writable transactions. Effect SQL's transaction wrapper commits on success, rolls back on failure, and uses savepoints for nested transactions. The exact generic implementation is in [`effect@4.0.0-beta.107`'s `SqlClient.js`](https://unpkg.com/effect@4.0.0-beta.107/dist/unstable/sql/SqlClient.js) and [`SqlClient.d.ts`](https://unpkg.com/effect@4.0.0-beta.107/dist/unstable/sql/SqlClient.d.ts).
- The adapter's SQLite connection is scoped and finalized when its scope closes. Its default WAL and busy-timeout behavior is independent of extension loading.

**Plan consequence:** create one scoped client, load the extension once on that connection before vector queries, and keep extension loading outside ordinary write transactions. A second client/connection must load the extension separately because SQLite's load API loads into a database connection.

### SQLite loadable-extension requirements

SQLite's [Run-Time Loadable Extensions](https://sqlite.org/loadext.html) documentation says:

- A loadable extension is a shared library/DLL (`.so` on Unix, `.dylib` on macOS, `.dll` on Windows).
- `sqlite3_load_extension()` loads it into the supplied database connection.
- Extension loading is disabled by default and must be enabled by the host's SQLite build/API.
- The library must match the host process's operating system and architecture; the documented compiler examples use `-fPIC -shared` on Unix, `-dynamiclib` on macOS, and a DLL on Windows.
- With a null entry point, SQLite derives the symbol from the filename. A file named `vector.so`, `vector.dylib`, or `vector.dll` resolves the `sqlite3_vector_init` entry point used by SQLite-Vector.

The SQLite-Vector source exports [`sqlite3_vector_init`](https://github.com/sqliteai/sqlite-vector/blob/1.1.2/src/sqlite-vector.c) and its [Makefile](https://github.com/sqliteai/sqlite-vector/blob/main/Makefile) builds a shared library with these target suffixes. The [1.1.2 release](https://github.com/sqliteai/sqlite-vector/releases/tag/1.1.2) (asset metadata: [GitHub release API](https://api.github.com/repos/sqliteai/sqlite-vector/releases/tags/1.1.2)) contains:

| Antisprawl target | Release asset                        | Extracted file                  |
| ----------------- | ------------------------------------ | ------------------------------- |
| Linux x64         | `vector-linux-x86_64-1.1.2.tar.gz`   | `vector.so`                     |
| Linux arm64       | `vector-linux-arm64-1.1.2.tar.gz`    | `vector.so`                     |
| macOS x64         | `vector-macos-x86_64-1.1.2.tar.gz`   | `vector.dylib`                  |
| macOS arm64       | `vector-macos-arm64-1.1.2.tar.gz`    | `vector.dylib`                  |
| Windows x64       | `vector-windows-x86_64-1.1.2.tar.gz` | `vector.dll` (and `vector.lib`) |

The release also publishes Linux musl and Android/iOS assets, but those are outside Antisprawl's initial target matrix. There is no Windows arm64 SQLite-Vector asset in this release and Windows arm64 is not an initial Antisprawl target.

**Important filename rule:** Bun's embedded-file names include a content hash (for example `vector-jewby5mt.so`). SQLite would derive the wrong entry point from that name, and a virtual `/$bunfs/...` path is not a native-library path anyway. Always extract to the canonical basename (`vector.so`, `vector.dylib`, or `vector.dll`) or call `loadExtension` with the explicit entry point `sqlite3_vector_init`.

### Bun extension loading and compiled assets

Bun's [SQLite documentation](https://bun.com/docs/runtime/sqlite) documents `Database.loadExtension(name)` and the macOS caveat:

- On macOS, Apple's SQLite build does not support extensions. `Database.setCustomSQLite(path)` must point to a vanilla `.dylib` and must run before any `Database` instance is created. Bun says this is a no-op on other operating systems.
- `loadExtension` accepts a native shared-library path and reports the underlying SQLite loader error.

Bun's [single-file executable documentation](https://bun.com/docs/bundler/executables) documents:

- Supported compile targets include `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`, `bun-darwin-x64`, and `bun-darwin-arm64` (plus targets outside the initial release matrix).
- `with { type: "file" }` and `--asset` embed arbitrary files in a standalone executable. Embedded files are exposed through an internal `/$bunfs/...` path and can be read using `Bun.file()`/filesystem APIs.
- Therefore a native extension must be copied from the embedded bytes to a real path before `Database.loadExtension`.
- macOS standalone binaries and their native libraries need normal code-signing/Gatekeeper treatment. SQLite-Vector's macOS release workflow codesigns and notarizes its `.dylib` assets; the release process must preserve that provenance when embedding/extracting them.

The current Bun source corroborates the runtime behavior: [`JSSQLStatement.cpp`](https://github.com/oven-sh/bun/blob/main/src/jsc/bindings/sqlite/JSSQLStatement.cpp) calls `sqlite3_load_extension`; [`JSSQLStatement.h`](https://github.com/oven-sh/bun/blob/main/src/jsc/bindings/sqlite/JSSQLStatement.h) enables lazy custom SQLite loading on Apple targets; and the SQLite binding checks for `SQLITE_OMIT_LOAD_EXTENSION` and reports an explicit failure when the runtime lacks it.

### Fallback

The accepted architecture already specifies a pure-Bun exact cosine scan over ordinary vector BLOBs when extension extraction/loading is unsupported. Keep this as a first-class path:

- Store ordinary vector BLOBs in the index regardless of extension availability.
- Use SQLite-Vector's `vector_full_scan` only after successful loading and a small capability probe.
- If extraction, checksum verification, custom SQLite setup, dynamic loading, or the probe fails, record the failure in bounded diagnostics and use the pure-Bun scan. Do not make hooks fail closed or require a rebuild.
- `status` should expose extension availability and the fallback/degraded state.

This preserves structural-only operation and exact search on all supported targets even when native extension support is absent.

## Empirical verification

These checks ran outside the repository in an isolated temporary directory; no product code was changed.

1. Built/installed exact `effect@4.0.0-beta.107` and `@effect/sql-sqlite-bun@4.0.0-beta.107` with Bun 1.4.2 on Linux x64.
2. Downloaded the official `vector-linux-x86_64-1.1.2.tar.gz`, extracted its `vector.so`, and loaded it with a direct `bun:sqlite` script. `select vector_version()` returned `1.1.2`; `vector_full_scan` returned row 1 at distance 0.
3. Compiled a standalone Bun executable with the extension embedded as a file asset, copied the embedded bytes to a temporary canonical `vector.so`, loaded it, and ran the same vector query successfully. The executable reported `Bun.isStandaloneExecutable === true`.
4. Compiled the same scenario through `@effect/sql-sqlite-bun`'s `SqliteClient.layer`. `client.loadExtension(...)` succeeded in the standalone executable and vector queries returned the expected result.
5. Exercised the Effect SQL transaction wrapper: an inserted vector committed successfully, and a second insert inside a failing transaction was rolled back.
6. Attempted to load the hashed embedded `/$bunfs/.../vector-<hash>.so` path directly. It failed before loading (virtual path plus SQLite's suffix handling), confirming that extraction and canonical naming/explicit entry point are required.

The other four accepted target combinations need CI or native runners. The source-backed asset/ABI evidence supports them, but the release gate must run a compiled executable and vector capability probe for each one.

## Implementation-planning constraints

1. Pin a Bun toolchain version and test the exact version used for release; Effect beta.107 only defines the adapter contract, not native-library compatibility.
2. Select one SQLite-Vector version and record its asset URLs, checksums, exported entry point, and target mapping in release provenance.
3. Embed one target-specific extension asset per executable; do not attempt a universal native library.
4. Extract atomically into a private, versioned cache, preserving the canonical filename or passing `sqlite3_vector_init` explicitly. Avoid replacing a library currently loaded by a live process.
5. For macOS, package/extract a compatible non-Apple `libsqlite3.dylib`, call `Database.setCustomSQLite` before the first client layer opens a database, and preserve code signatures/notarization. This is the main additional design decision not explicit in the current architecture.
6. Load the extension once per SQLite connection, before concurrent queries. Probe `vector_version()` (or equivalent) after loading.
7. Keep ordinary BLOB persistence and the pure-Bun exact scan as the guaranteed fallback. Extension failure is a degraded advisory capability, not an indexing/data-loss error.
8. Add acceptance tests for extraction, checksum mismatch, wrong architecture, missing loader support, canonical entry-point naming, transaction rollback, and all five initial target combinations.

## Primary sources

- [Effect package metadata](https://unpkg.com/@effect/sql-sqlite-bun@4.0.0-beta.107/package.json)
- [Effect Bun SQLite source, beta.107](https://unpkg.com/@effect/sql-sqlite-bun@4.0.0-beta.107/src/SqliteClient.ts)
- [Effect SQL transaction source, beta.107](https://unpkg.com/effect@4.0.0-beta.107/dist/unstable/sql/SqlClient.js)
- [Bun SQLite documentation](https://bun.com/docs/runtime/sqlite)
- [Bun standalone executable documentation](https://bun.com/docs/bundler/executables)
- [Bun SQLite binding source](https://github.com/oven-sh/bun/tree/main/src/jsc/bindings/sqlite)
- [SQLite loadable extensions](https://sqlite.org/loadext.html)
- [SQLite-Vector README](https://github.com/sqliteai/sqlite-vector/blob/1.1.2/README.md)
- [SQLite-Vector Makefile](https://github.com/sqliteai/sqlite-vector/blob/main/Makefile)
- [SQLite-Vector extension entry point](https://github.com/sqliteai/sqlite-vector/blob/1.1.2/src/sqlite-vector.c)
- [SQLite-Vector 1.1.2 release assets](https://github.com/sqliteai/sqlite-vector/releases/tag/1.1.2) and [release API metadata](https://api.github.com/repos/sqliteai/sqlite-vector/releases/tags/1.1.2)
