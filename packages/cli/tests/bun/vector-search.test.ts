import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { nativeSearch } from "../../src/app.ts";
import { detectProbableDuplicates, type IndexedSymbol } from "../../src/detector.ts";
import { configuredEmbeddingProvider } from "../../src/embedding.ts";
import provenance from "../../vendor/sqlite-vec/provenance.json" with { type: "json" };
import { searchNativeCandidates, sqliteVecHost } from "../../src/vector-search.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const vector = (...values: number[]) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);

  values.forEach((value, index) => view.setFloat32(index * 4, value, true));

  return bytes;
};

const symbol = (name: string, embeddingHash: string): IndexedSymbol => ({
  path: `src/${name}.ts`,
  language: "typescript",
  key: name,
  qualifiedName: name,
  kind: "function",
  startByte: 0,
  endByte: 1,
  startRow: 0,
  startColumn: 0,
  endRow: 0,
  endColumn: 1,
  tokenCount: 20,
  strictHash: name,
  normalizedHash: "same-normalized",
  orderedTokenHashes: new Uint8Array(),
  qgramHashes: new Uint8Array(),
  embeddingHash,
});

const boundaryVectors = () => {
  const dimensions = 384;
  const tail = Math.fround(2 ** -12.5 * (1 - 2 ** -22));
  const tailSquared = (dimensions - 2) * tail * tail;
  // This keeps application cosine above 0.85 while native cosine falls over 1e-6 below it.
  const boundaryAdjustment = 0.13 * tailSquared;
  const query = new Float32Array(dimensions);
  const candidate = new Float32Array(dimensions);

  query[0] = 1;
  candidate[0] = Math.fround(0.85 - boundaryAdjustment);
  candidate[1] = Math.fround(Math.sqrt(1 - candidate[0] ** 2));
  query.fill(tail, 2);
  candidate.fill(tail, 2);

  return [query, candidate] as const;
};

const withIndex = Effect.fn("VectorSearchTest.withIndex")(function* <A, E>(
  use: (indexPath: string, cachePath: string) => Effect.Effect<A, E, BunServices.BunServices>,
  vectors: ReadonlyArray<readonly [string, Uint8Array]> = [
    ["exact", vector(1, 0)],
    ["near", vector(0.8, 0.6)],
    ["orthogonal", vector(0, 1)],
  ],
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

  for (const [hash, bytes] of vectors) {
    database
      .query("INSERT INTO vectors VALUES (?, ?, ?, ?)")
      .run("identity", hash, bytes.byteLength / 4, bytes);
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
            0.85,
          );

          expect(candidates).toEqual([
            ["exact", "near", "orthogonal"],
            ["exact", "near", "orthogonal"],
          ]);
          expect(thresholded).toEqual(["exact"]);

          const appDirectory = paths.join(cachePath, "antisprawl");
          const [versionDirectory] = yield* fs.readDirectory(appDirectory);

          const host = sqliteVecHost(process.platform, process.arch);
          const record = host === undefined ? undefined : provenance.libraries[host];
          const filename = record?.library.slice(record.library.lastIndexOf("/") + 1);

          expect(host).toBeDefined();
          expect(record).toBeDefined();
          expect(versionDirectory).toContain(`sqlite-vec-v0.1.9-${host}-`);
          expect((yield* fs.stat(appDirectory)).mode & 0o777).toBe(0o700);
          expect(
            (yield* fs.stat(paths.join(appDirectory, versionDirectory!, filename!))).mode & 0o777,
          ).toBe(0o600);
        }),
      ),
    ),
  ));

test("native search wiring preserves boundary Findings while reducing rescoring", () => {
  const [query, boundary] = boundaryVectors();
  const far = new Float32Array(query.length);

  far[1] = 1;

  const queryHash = "11".repeat(32);
  const boundaryHash = "22".repeat(32);
  const farHash = "33".repeat(32);
  const edited = symbol("edited", queryHash);
  const candidate = symbol("candidate", boundaryHash);
  const rejected = symbol("rejected", farHash);

  const vectors = new Map([
    [queryHash, query],
    [boundaryHash, boundary],
    [farHash, far],
  ]);

  const provider = configuredEmbeddingProvider("openai", {})!;

  return run(
    Effect.scoped(
      withIndex(
        (indexPath) =>
          Effect.gen(function* () {
            const search = yield* nativeSearch(
              { indexPath, provider },
              {
                profile: {
                  ...provider.profile,
                  identityHash: "identity",
                  complete: true,
                  usage: { requests: 0, inputs: 0, inputTokens: 0, durationMs: 0 },
                },
                vectors,
              },
              [edited],
            );

            expect(search.path).toBe("sqlite_vec");

            if (search.path !== "sqlite_vec") throw new Error("Expected native vector search.");

            const fallback = detectProbableDuplicates([edited], [edited, candidate, rejected], {
              threshold: 0.85,
              vectors,
            });

            const native = detectProbableDuplicates([edited], [edited, candidate, rejected], {
              threshold: 0.85,
              vectors,
              candidateHashesByQuery: search.candidateHashesByQuery,
            });

            expect(native.findings).toEqual(fallback.findings);
            expect(native.rescored).toBe(1);
            expect(fallback.rescored).toBe(2);
          }),
        [
          [queryHash, vector(...query)],
          [boundaryHash, vector(...boundary)],
          [farHash, vector(...far)],
        ],
      ),
    ),
  );
});

test("sqlite-vec host mapping covers the five CLI targets", () => {
  expect(sqliteVecHost("linux", "x64")).toBe("linux-x64");
  expect(sqliteVecHost("linux", "arm64")).toBe("linux-arm64");
  expect(sqliteVecHost("darwin", "x64")).toBe("darwin-x64");
  expect(sqliteVecHost("darwin", "arm64")).toBe("darwin-arm64");
  expect(sqliteVecHost("win32", "x64")).toBe("windows-x64");
  expect(sqliteVecHost("win32", "arm64")).toBeUndefined();
  expect(sqliteVecHost("freebsd", "x64")).toBeUndefined();
  expect(Object.keys(provenance.libraries).sort()).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-x64",
  ]);
});

test("vendored sqlite-vec loadables match provenance digests", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;

      for (const record of Object.values(provenance.libraries)) {
        const bytes = yield* fs.readFile(
          paths.join(import.meta.dir, "../../vendor/sqlite-vec", record.library),
        );

        expect(Bun.CryptoHasher.hash("sha256", bytes, "hex"), record.library).toBe(
          record.librarySha256,
        );
      }
    }),
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
