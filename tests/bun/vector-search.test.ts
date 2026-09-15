import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { searchNativeCandidates } from "../../src/vector-search.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const vector = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);

  values.forEach((value, index) => view.setFloat32(index * 4, value, true));

  return bytes;
};

const withIndex = Effect.fn("VectorSearchTest.withIndex")(function* <A, E>(
  use: (indexPath: string, cachePath: string) => Effect.Effect<A, E, BunServices.BunServices>,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-vector-search-" });
  const indexPath = paths.join(root, "index.sqlite");
  const database = new Database(indexPath);

  database.run(`
    CREATE TABLE vectors (
      embedding_identity TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (embedding_identity, input_hash)
    ) STRICT
  `);

  for (const [hash, bytes] of [
    ["exact", vector(1, 0)],
    ["near", vector(0.8, 0.6)],
    ["orthogonal", vector(0, 1)],
  ] as const) {
    database.query("INSERT INTO vectors VALUES (?, ?, 2, ?)").run("identity", hash, bytes);
  }

  database.close();

  return yield* use(indexPath, paths.join(root, "cache"));
});

test("sqlite-vec retrieves all ordinary vector BLOB candidates by cosine", () =>
  run(
    Effect.scoped(
      withIndex((indexPath, cachePath) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;

          const searches = [
            searchNativeCandidates(indexPath, "identity", vector(1, 0), 2, {
              XDG_CACHE_HOME: cachePath,
            }),
            searchNativeCandidates(indexPath, "identity", vector(1, 0), 2, {
              XDG_CACHE_HOME: cachePath,
            }),
          ];

          const candidates = yield* Effect.all(searches, { concurrency: "unbounded" });

          const thresholded = yield* searchNativeCandidates(
            indexPath,
            "identity",
            vector(1, 0),
            2,
            { XDG_CACHE_HOME: cachePath },
            0.21,
          );

          expect(candidates).toEqual([
            ["exact", "near", "orthogonal"],
            ["exact", "near", "orthogonal"],
          ]);
          expect(thresholded).toEqual(["exact", "near"]);

          const appDirectory = paths.join(cachePath, "antisprawl");
          const [versionDirectory] = yield* fs.readDirectory(appDirectory);

          expect((yield* fs.stat(appDirectory)).mode & 0o777).toBe(0o700);
          expect(
            (yield* fs.stat(paths.join(appDirectory, versionDirectory!, "vec0.so"))).mode & 0o777,
          ).toBe(0o600);
        }),
      ),
    ),
  ));

test("native digest, extraction, load, and probe failures stay safe", () =>
  run(
    Effect.scoped(
      withIndex((indexPath, cachePath) =>
        Effect.gen(function* () {
          for (const failure of ["digest", "extract", "load", "probe"] as const) {
            const error = yield* Effect.flip(
              searchNativeCandidates(indexPath, "identity", vector(1, 0), 2, {
                XDG_CACHE_HOME: cachePath,
                ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE: failure,
              }),
            );

            expect(error, failure).toMatchObject({
              code: "vector_search_unavailable",
              message: "Native vector search is unavailable.",
            });
            expect(`${error.code} ${error.message}`).not.toContain(cachePath);
          }
        }),
      ),
    ),
  ));
