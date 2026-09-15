import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readIndex, updateIndex, type FileRecord, type IndexIdentity } from "../../src/index.ts";
import type { StructuralRepresentation } from "../../src/representation.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const identity: IndexIdentity = {
  configHash: "config",
  grammarManifestSha256: "manifest",
  detectorVersion: 1,
  structuralPolicyVersion: 1,
};

const symbol = (key: string): StructuralRepresentation => ({
  key,
  qualifiedName: key,
  kind: "function",
  startByte: 0,
  endByte: 1,
  startRow: 0,
  startColumn: 0,
  endRow: 0,
  endColumn: 1,
  tokenCount: 1,
  strictHash: "01".repeat(32),
  normalizedHash: "02".repeat(32),
  orderedTokenHashes: new Uint8Array(32).fill(1),
  qgramHashes: new Uint8Array(),
});

const file = (
  contentHash: string,
  symbols: ReadonlyArray<StructuralRepresentation>,
  path = "src/example.ts",
): FileRecord => ({
  path,
  contentHash,
  parseStatus: "current",
  symbols,
});

test("changed-file replacement is transactional", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const error = yield* Effect.flip(
          updateIndex(
            indexPath,
            identity,
            [{ path: "src/example.ts", contentHash: "new" }],
            [file("new", [symbol("duplicate"), symbol("duplicate")])],
          ),
        );

        expect(error).toMatchObject({ code: "index_update_failed" });

        const database = new Database(indexPath, { readonly: true });

        expect(database.query("select content_hash from files").get()).toEqual({
          content_hash: "old",
        });
        expect(database.query("select symbol_key from symbols").all()).toEqual([
          { symbol_key: "old" },
        ]);
        database.close();

        const work = yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "new" }],
          [file("new", [symbol("new")])],
        );

        expect(work).toEqual({
          files: { indexed: 1, reused: 0, removed: 0 },
          symbols: { indexed: 1, reused: 0, removed: 1 },
        });

        const replaced = new Database(indexPath, { readonly: true });

        expect(replaced.query("select content_hash from files").get()).toEqual({
          content_hash: "new",
        });
        expect(replaced.query("select symbol_key from symbols").all()).toEqual([
          { symbol_key: "new" },
        ]);
        replaced.close();
      }),
    ),
  ));

test("one failed replacement rolls back the whole refresh", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [
            { path: "src/a.ts", contentHash: "old-a" },
            { path: "src/b.ts", contentHash: "old-b" },
          ],
          [
            file("old-a", [symbol("old-a")], "src/a.ts"),
            file("old-b", [symbol("old-b")], "src/b.ts"),
          ],
        );

        const error = yield* Effect.flip(
          updateIndex(
            indexPath,
            identity,
            [
              { path: "src/a.ts", contentHash: "new-a" },
              { path: "src/b.ts", contentHash: "new-b" },
            ],
            [
              file("new-a", [symbol("new-a")], "src/a.ts"),
              file("new-b", [symbol("duplicate"), symbol("duplicate")], "src/b.ts"),
            ],
          ),
        );

        expect(error).toMatchObject({ code: "index_update_failed" });

        const database = new Database(indexPath, { readonly: true });

        expect(database.query("select path, content_hash from files order by path").all()).toEqual([
          { path: "src/a.ts", content_hash: "old-a" },
          { path: "src/b.ts", content_hash: "old-b" },
        ]);
        database.close();
      }),
    ),
  ));

test("Index snapshots expose current Symbols and count removals", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const snapshot = yield* readIndex(indexPath, identity);

        expect(snapshot.files.get("src/example.ts")).toEqual({
          contentHash: "old",
          parseStatus: "current",
          symbolCount: 1,
        });
        expect(snapshot.symbols).toEqual([
          { path: "src/example.ts", language: "typescript", ...symbol("old") },
        ]);

        expect(yield* updateIndex(indexPath, identity, [], [])).toEqual({
          files: { indexed: 0, reused: 0, removed: 1 },
          symbols: { indexed: 0, reused: 0, removed: 1 },
        });
      }),
    ),
  ));

test("logical Symbol corruption is rejected", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const database = new Database(indexPath);

        database.query("delete from symbols").run();
        database.close();

        const error = yield* Effect.flip(readIndex(indexPath, identity));

        expect(error).toMatchObject({ code: "index_invalid" });
      }),
    ),
  ));

test("unexpected persistent state is rejected as an incompatible schema", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const database = new Database(indexPath);

        database.run("create table findings (id text)");
        database.close();

        expect(yield* Effect.flip(readIndex(indexPath, identity))).toMatchObject({
          code: "index_incompatible",
        });

        const metadataDatabase = new Database(indexPath);

        metadataDatabase.run("drop table findings");
        metadataDatabase.run("insert into metadata values ('credential', 'secret')");
        metadataDatabase.close();

        expect(yield* Effect.flip(readIndex(indexPath, identity))).toMatchObject({
          code: "index_incompatible",
        });
      }),
    ),
  ));

test("invalid Symbol fingerprints are rejected", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const database = new Database(indexPath);

        database.run("update symbols set ordered_token_hashes = x'01'");
        database.close();

        expect(yield* Effect.flip(readIndex(indexPath, identity))).toMatchObject({
          code: "index_invalid",
        });
      }),
    ),
  ));

test("an incompatible Index is rejected without modification", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });
        const indexPath = paths.join(root, "index.sqlite");
        const database = new Database(indexPath);

        database.query("PRAGMA user_version = 99").run();
        database.close();

        const before = yield* fs.readFile(indexPath);
        const error = yield* Effect.flip(updateIndex(indexPath, identity, [], []));

        expect(error).toMatchObject({ code: "index_incompatible" });
        expect(yield* fs.readFile(indexPath)).toEqual(before);
      }),
    ),
  ));
