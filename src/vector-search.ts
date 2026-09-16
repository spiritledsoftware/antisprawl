import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sqliteVecAsset from "../vendor/sqlite-vec/linux-x64/vec0.so" with { type: "file" };
import { appError } from "./errors.ts";

const version = "v0.1.9";

const librarySha256 = "5923730861b86c707cca5602b5f91092f9e52a46706dbc6e269fd4bb9c4498e8";

const ProbeRow = Schema.Struct({ version: Schema.Literal(version), distance: Schema.Finite });

const CandidateRows = Schema.Array(Schema.Struct({ input_hash: Schema.String }));

const float32UnitRoundoff = 2 ** -24;

const float64UnitRoundoff = 2 ** -53;

const float32Maximum = 3.402_823_466_385_288_6e38;

const float32MinimumNormalRoot = 2 ** -63;

const validNativeDimensions = (dimensions: number) =>
  dimensions > 0 && 4 * dimensions * float32UnitRoundoff < 1;

const maximumNativeDistance = (minimumSimilarity: number, dimensions: number) => {
  const accumulationError =
    (4 * dimensions * float32UnitRoundoff) / (1 - 4 * dimensions * float32UnitRoundoff);

  const cosineError =
    accumulationError +
    float32UnitRoundoff * (2 + accumulationError) +
    16 * dimensions * float64UnitRoundoff;

  return Math.min(2, 1 - minimumSimilarity + cosineError);
};

export const nativeCosineSafe = (vectors: Iterable<Float32Array>, dimensions: number): boolean => {
  if (!validNativeDimensions(dimensions)) return false;

  const maximumComponent = Math.sqrt(float32Maximum / (2 * dimensions));

  for (const vector of vectors) {
    if (vector.length !== dimensions) return false;

    let nonzero = false;

    for (const value of vector) {
      const absolute = Math.abs(value);

      if (
        !Number.isFinite(value) ||
        (absolute !== 0 && (absolute < float32MinimumNormalRoot || absolute > maximumComponent))
      ) {
        return false;
      }

      nonzero ||= absolute !== 0;
    }

    if (!nonzero) return false;
  }

  return true;
};

const safeError = () =>
  appError("vector_search_unavailable", "Native vector search is unavailable.");

const sha256 = (bytes: Uint8Array) => Bun.CryptoHasher.hash("sha256", bytes, "hex");

const extractedLibrary = Effect.fn("VectorSearch.extract")(function* (
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (process.platform !== "linux" || process.arch !== "x64") return yield* safeError();

  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const bundled = yield* fs.readFile(sqliteVecAsset);

  if (
    environment.ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE === "digest" ||
    sha256(bundled) !== librarySha256
  ) {
    return yield* safeError();
  }

  if (environment.ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE === "extract") {
    return yield* safeError();
  }

  const cacheRoot = environment.XDG_CACHE_HOME ?? paths.join(homedir(), ".cache");
  const appDirectory = paths.join(cacheRoot, "antisprawl");
  const directory = paths.join(appDirectory, `sqlite-vec-${version}-linux-x64-${librarySha256}`);
  const library = paths.join(directory, "vec0.so");

  yield* fs.makeDirectory(appDirectory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(appDirectory, 0o700);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);

  const existing = yield* fs.exists(library);
  const valid = existing && sha256(yield* fs.readFile(library)) === librarySha256;

  if (!valid) {
    const temporary = paths.join(directory, `.vec0-${process.pid}-${Bun.randomUUIDv7()}.so`);

    yield* fs
      .writeFile(temporary, bundled)
      .pipe(
        Effect.andThen(fs.chmod(temporary, 0o600)),
        Effect.andThen(fs.rename(temporary, library)),
        Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
      );
  }

  yield* fs.chmod(library, 0o600);

  if (sha256(yield* fs.readFile(library)) !== librarySha256) return yield* safeError();

  return library;
});

export const searchNativeCandidates = Effect.fn("VectorSearch.searchNativeCandidates")(function* (
  indexPath: string,
  embeddingIdentity: string,
  queryVector: Uint8Array,
  dimensions: number,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  minimumSimilarity = -1,
) {
  const search = Effect.gen(function* () {
    if (
      queryVector.byteLength !== dimensions * 4 ||
      !validNativeDimensions(dimensions) ||
      !Number.isFinite(minimumSimilarity) ||
      minimumSimilarity < -1 ||
      minimumSimilarity > 1
    ) {
      return yield* safeError();
    }

    const library = yield* extractedLibrary(environment);
    const maximumDistance = maximumNativeDistance(minimumSimilarity, dimensions);

    const queried = yield* Effect.try({
      try: () => {
        const database = new Database(indexPath, { readonly: true });

        try {
          if (environment.ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE === "load") {
            throw safeError();
          }

          database.loadExtension(library);

          if (environment.ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE === "probe") {
            throw safeError();
          }

          const probeVector = new Uint8Array(new Float32Array([1, 0]).buffer);

          const probe = database
            .query("SELECT vec_version() AS version, vec_distance_cosine(?1, ?1) AS distance")
            .get(probeVector);

          const candidates = database
            .query(
              `SELECT input_hash
               FROM vectors
               WHERE embedding_identity = ?2
                 AND dimensions = ?3
                 AND vec_distance_cosine(vector, ?1) <= ?4
               ORDER BY vec_distance_cosine(vector, ?1), input_hash`,
            )
            .all(queryVector, embeddingIdentity, dimensions, maximumDistance);

          return { probe, candidates };
        } finally {
          database.close();
        }
      },
      catch: safeError,
    });

    const probe = yield* Schema.decodeUnknownEffect(ProbeRow)(queried.probe).pipe(
      Effect.mapError(safeError),
    );

    if (probe.distance !== 0) return yield* safeError();

    const candidates = yield* Schema.decodeUnknownEffect(CandidateRows)(queried.candidates).pipe(
      Effect.mapError(safeError),
    );

    return candidates.map((row) => row.input_hash);
  });

  return yield* search.pipe(Effect.mapError(safeError));
});
