import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { Profile } from "../../src/embedding.ts";
import {
  readIndex,
  updateIndex,
  withIndexSession,
  type FileRecord,
  type IndexIdentity,
  type IndexSession,
} from "../../src/index.ts";
import type { StructuralRepresentation } from "../../src/representation.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const inIndexSession = <A, E, R>(
  indexPath: string,
  use: (session: IndexSession) => Effect.Effect<A, E, R>,
) =>
  readIndex(indexPath, identity).pipe(
    Effect.flatMap((snapshot) => withIndexSession(indexPath, identity, snapshot, use)),
  );

const temporaryIndexPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });

  return paths.join(root, "index.sqlite");
});

const identity: IndexIdentity = {
  configHash: "config",
  grammarManifestSha256: "manifest",
  detectorVersion: 1,
  structuralPolicyVersion: 1,
};

const profile: Profile = {
  provider: "deterministic",
  model: "acceptance-v1",
  dimensions: 2,
  language: "typescript",
  representation: 1,
  detector: 2,
  semanticThreshold: 0.85,
  calibration: "calibrated",
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
  embeddingHash: "03".repeat(32),
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
        const indexPath = yield* temporaryIndexPath;

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
        const indexPath = yield* temporaryIndexPath;

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
        const indexPath = yield* temporaryIndexPath;

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

test("an Index session rejects a stale structural update", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [symbol("old")])],
        );

        const snapshot = yield* readIndex(indexPath, identity);

        yield* withIndexSession(indexPath, identity, snapshot, (session) =>
          Effect.gen(function* () {
            yield* updateIndex(
              indexPath,
              identity,
              [{ path: "src/example.ts", contentHash: "external" }],
              [file("external", [symbol("external")])],
            );

            const error = yield* Effect.flip(
              session.updateIndex(
                [{ path: "src/example.ts", contentHash: "ours" }],
                [file("ours", [symbol("ours")])],
              ),
            );

            expect(error).toMatchObject({ code: "index_currentness_changed" });
          }),
        );
      }),
    ),
  ));

test("an Index session rejects an incompatible Profile change between batches", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const firstHash = "04".repeat(32);
        const secondHash = "05".repeat(32);
        const nextProfile = { ...profile, model: "acceptance-v2" };

        yield* updateIndex(indexPath, identity, [], []);

        const snapshot = yield* readIndex(indexPath, identity);

        yield* withIndexSession(indexPath, identity, snapshot, (session) =>
          Effect.gen(function* () {
            yield* session.activateProfile(profile);
            yield* session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: firstHash, vector: new Float32Array([1, 0]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            });

            const current = yield* readIndex(indexPath, identity);

            yield* withIndexSession(indexPath, identity, current, (other) =>
              other.activateProfile(nextProfile),
            );

            const error = yield* Effect.flip(
              session.persistEmbeddingBatch(profile, {
                vectors: [{ hash: secondHash, vector: new Float32Array([0, 1]) }],
                usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
              }),
            );

            expect(error).toMatchObject({ code: "embedding_profile_changed" });
          }),
        );

        const changed = yield* readIndex(indexPath, identity);

        expect(changed.profile).toMatchObject({
          model: nextProfile.model,
          usage: { requests: 0, inputs: 0, inputTokens: 0, durationMs: 0 },
        });

        yield* withIndexSession(indexPath, identity, changed, (session) =>
          session.activateProfile(profile),
        );

        expect([...(yield* readIndex(indexPath, identity)).vectors.keys()]).toEqual([firstHash]);
      }),
    ),
  ));

test("one Index session validates the complete snapshot once across embedding batches", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;

        yield* updateIndex(indexPath, identity, [], []);

        const query = spyOn(Database.prototype, "query");

        yield* Effect.gen(function* () {
          const snapshot = yield* readIndex(indexPath, identity);

          yield* withIndexSession(indexPath, identity, snapshot, (session) =>
            Effect.gen(function* () {
              yield* session.activateProfile(profile);

              for (const hash of ["04".repeat(32), "05".repeat(32)]) {
                yield* session.persistEmbeddingBatch(profile, {
                  vectors: [{ hash, vector: new Float32Array([1, 0]) }],
                  usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
                });
              }

              yield* session.completeProfile(profile);
            }),
          );

          const vectorSnapshotReads = query.mock.calls.filter(([sql]) =>
            String(sql).includes(
              "SELECT embedding_identity, input_hash, dimensions, vector FROM vectors",
            ),
          );

          expect(vectorSnapshotReads).toHaveLength(1);
        }).pipe(Effect.ensuring(Effect.sync(() => query.mockRestore())));
      }),
    ),
  ));

test("complete embedding batches are durable and threshold changes reuse vectors", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const represented = symbol("current");

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "current" }],
          [file("current", [{ ...represented, tokenCount: 20 }])],
        );
        yield* inIndexSession(indexPath, (session) => session.activateProfile(profile));

        expect(
          yield* inIndexSession(indexPath, (session) =>
            session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: represented.embeddingHash, vector: new Float32Array([1, -2.5]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 7, durationMs: 3 },
            }),
          ),
        ).toEqual({ indexed: 1, reused: 0 });

        const partial = yield* readIndex(indexPath, identity);

        expect(partial.profile).toMatchObject({
          ...profile,
          complete: false,
          usage: { requests: 1, inputs: 1, inputTokens: 7, durationMs: 3 },
        });
        expect([...partial.vectors.get(represented.embeddingHash)!]).toEqual([1, -2.5]);
        expect(
          yield* inIndexSession(indexPath, (session) => session.completeProfile(profile)),
        ).toEqual({ removed: 0 });
        expect((yield* readIndex(indexPath, identity)).profile?.complete).toBe(true);

        const rescored = { ...profile, semanticThreshold: 0.9 };

        yield* inIndexSession(indexPath, (session) => session.activateProfile(rescored));
        expect(
          yield* inIndexSession(indexPath, (session) => session.completeProfile(rescored)),
        ).toEqual({ removed: 0 });
        expect([...(yield* readIndex(indexPath, identity)).vectors.keys()]).toEqual([
          represented.embeddingHash,
        ]);
      }),
    ),
  ));

test("different models never mix vectors even when dimensions match", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const represented = { ...symbol("current"), tokenCount: 20 };
        const nextProfile = { ...profile, model: "acceptance-v2" };

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "current" }],
          [file("current", [represented])],
        );
        yield* inIndexSession(indexPath, (session) =>
          Effect.gen(function* () {
            yield* session.activateProfile(profile);
            yield* session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: represented.embeddingHash, vector: new Float32Array([1, 0]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            });
            yield* session.completeProfile(profile);
            yield* session.activateProfile(nextProfile);
          }),
        );

        expect((yield* readIndex(indexPath, identity)).vectors.size).toBe(0);

        yield* inIndexSession(indexPath, (session) =>
          Effect.gen(function* () {
            yield* session.persistEmbeddingBatch(nextProfile, {
              vectors: [{ hash: represented.embeddingHash, vector: new Float32Array([0, 1]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            });
            yield* session.completeProfile(nextProfile);
          }),
        );

        const database = new Database(indexPath, { readonly: true });

        expect(database.query("select count(*) as count from vectors").get()).toEqual({ count: 1 });
        database.close();
        expect([...(yield* readIndex(indexPath, identity)).vectors.values()][0]).toEqual(
          new Float32Array([0, 1]),
        );
      }),
    ),
  ));

test("Profile activation rejects incompatible dormant vector dimensions", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const represented = { ...symbol("current"), tokenCount: 20 };
        const nextProfile = { ...profile, model: "acceptance-v2" };

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "current" }],
          [file("current", [represented])],
        );
        yield* inIndexSession(indexPath, (session) =>
          Effect.gen(function* () {
            yield* session.activateProfile(profile);
            yield* session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: represented.embeddingHash, vector: new Float32Array([1, 0]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            });
            yield* session.completeProfile(profile);
            yield* session.activateProfile(nextProfile);
          }),
        );

        const database = new Database(indexPath);

        database.run("update vectors set dimensions = 1, vector = X'0000803f'");
        database.close();

        expect(
          yield* Effect.flip(
            inIndexSession(indexPath, (session) => session.activateProfile(profile)),
          ),
        ).toMatchObject({ code: "index_invalid" });
      }),
    ),
  ));

test("structural changes mark a complete Profile partial before replacing Symbols", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const oldSymbol = { ...symbol("old"), tokenCount: 20 };

        const newSymbol = {
          ...symbol("new"),
          tokenCount: 20,
          embeddingHash: "04".repeat(32),
        };

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "old" }],
          [file("old", [oldSymbol])],
        );
        yield* inIndexSession(indexPath, (session) =>
          Effect.gen(function* () {
            yield* session.activateProfile(profile);
            yield* session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: oldSymbol.embeddingHash, vector: new Float32Array([1, 0]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            });
            yield* session.completeProfile(profile);
          }),
        );

        yield* updateIndex(
          indexPath,
          identity,
          [{ path: "src/example.ts", contentHash: "new" }],
          [file("new", [newSymbol])],
        );

        const changed = yield* readIndex(indexPath, identity);

        expect(changed.profile?.complete).toBe(false);
        expect(changed.symbols[0]?.embeddingHash).toBe(newSymbol.embeddingHash);
      }),
    ),
  ));

test("an invalid embedding batch changes neither vectors nor usage", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;

        yield* updateIndex(indexPath, identity, [], []);
        yield* inIndexSession(indexPath, (session) => session.activateProfile(profile));

        const error = yield* Effect.flip(
          inIndexSession(indexPath, (session) =>
            session.persistEmbeddingBatch(profile, {
              vectors: [{ hash: "04".repeat(32), vector: new Float32Array([Number.NaN, 0]) }],
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            }),
          ),
        );

        expect(error).toMatchObject({ code: "embedding_vector_non_finite" });
        const snapshot = yield* readIndex(indexPath, identity);

        expect(snapshot.vectors.size).toBe(0);
        expect(snapshot.profile?.usage).toEqual({
          requests: 0,
          inputs: 0,
          inputTokens: 0,
          durationMs: 0,
        });
      }),
    ),
  ));

test("unexpected embedding batch exceptions remain defects", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;
        const defect = new Error("unexpected batch defect");

        yield* updateIndex(indexPath, identity, [], []);
        yield* inIndexSession(indexPath, (session) => session.activateProfile(profile));

        const exit = yield* Effect.exit(
          inIndexSession(indexPath, (session) =>
            session.persistEmbeddingBatch(profile, {
              get vectors(): never {
                throw defect;
              },
              usage: { requests: 1, inputs: 1, inputTokens: 1, durationMs: 1 },
            }),
          ),
        );

        expect(exit._tag).toBe("Failure");

        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.hasFails(exit.cause)).toBe(false);
        }
      }),
    ),
  ));

test("invalid persisted Profile semantics are rejected", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;

        yield* updateIndex(indexPath, identity, [], []);
        yield* inIndexSession(indexPath, (session) => session.activateProfile(profile));

        const database = new Database(indexPath);

        database.run("pragma ignore_check_constraints = on");
        database.run("update profile set semantic_threshold = 2");
        database.close();

        expect(yield* Effect.flip(readIndex(indexPath, identity))).toMatchObject({
          code: "index_invalid",
        });
      }),
    ),
  ));

test("logical Symbol corruption is rejected", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const indexPath = yield* temporaryIndexPath;

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
        const indexPath = yield* temporaryIndexPath;

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
        const indexPath = yield* temporaryIndexPath;

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
        const indexPath = yield* temporaryIndexPath;
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
