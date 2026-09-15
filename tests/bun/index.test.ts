import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  grammar: {
    language: "typescript",
    runtime: "0.27.0",
    parserCommit: "parser",
    parserAbi: 14,
    wasmSha256: "wasm",
    querySha256: "query",
    manifestSha256: "manifest",
  },
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

test("changed-file replacement is transactional", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-index-"));
  const indexPath = join(root, "index.sqlite");

  try {
    await run(
      updateIndex(
        indexPath,
        identity,
        [{ path: "src/example.ts", contentHash: "old" }],
        [file("old", [symbol("old")])],
      ),
    );

    const error = await run(
      Effect.flip(
        updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "new" }],
          [file("new", [symbol("duplicate"), symbol("duplicate")])],
        ),
      ),
    );

    expect(error).toMatchObject({ code: "index_update_failed" });

    const database = new Database(indexPath, { readonly: true });

    expect(database.query("select content_hash from files").get()).toEqual({
      content_hash: "old",
    });
    expect(database.query("select symbol_key from symbols").all()).toEqual([{ symbol_key: "old" }]);
    database.close();

    await run(
      updateIndex(
        indexPath,
        identity,
        [{ path: "src/example.ts", contentHash: "new" }],
        [file("new", [symbol("new")])],
      ),
    );

    const replaced = new Database(indexPath, { readonly: true });

    expect(replaced.query("select content_hash from files").get()).toEqual({
      content_hash: "new",
    });
    expect(replaced.query("select symbol_key from symbols").all()).toEqual([{ symbol_key: "new" }]);
    replaced.close();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("logical Symbol corruption is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-index-"));
  const indexPath = join(root, "index.sqlite");

  try {
    await run(
      updateIndex(
        indexPath,
        identity,
        [{ path: "src/example.ts", contentHash: "old" }],
        [file("old", [symbol("old")])],
      ),
    );

    const database = new Database(indexPath);

    database.query("delete from symbols").run();
    database.close();

    const error = await run(Effect.flip(readIndexedFiles(indexPath, identity)));

    expect(error).toMatchObject({ code: "index_invalid" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an incompatible Index is rejected without modification", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-index-"));
  const indexPath = join(root, "index.sqlite");

  try {
    const database = new Database(indexPath);

    database.exec("PRAGMA user_version = 99");
    database.close();

    const before = await Bun.file(indexPath).bytes();
    const error = await run(Effect.flip(updateIndex(indexPath, identity, [], [])));

    expect(error).toMatchObject({ code: "index_incompatible" });
    expect(await Bun.file(indexPath).bytes()).toEqual(before);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
