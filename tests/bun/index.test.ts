import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  readIndexedFiles,
  updateIndex,
  type FileRecord,
  type IndexIdentity,
} from "../../src/index.ts";
import type { StructuralRepresentation } from "../../src/representation.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const identity: IndexIdentity = {
  configHash: "config",
  grammarManifestSha256: "manifest",
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
  strictHash: "strict",
  normalizedHash: "normalized",
  orderedTokenHashes: new Uint8Array([1]),
  qgramHashes: new Uint8Array(),
});

const file = (
  contentHash: string,
  symbols: ReadonlyArray<StructuralRepresentation>,
): FileRecord => ({
  path: "src/example.ts",
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

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "new" }],
          [file("new", [symbol("new")])],
        );

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

        const error = yield* Effect.flip(readIndexedFiles(indexPath, identity));

        expect(error).toMatchObject({ code: "index_invalid" });
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
