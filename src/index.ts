import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { IndexedSymbol } from "./detector.ts";
import { structuralPolicy } from "./detector.ts";
import {
  decodeVector,
  embeddingIdentityHash,
  encodeVector,
  type EmbeddedBatch,
  type EmbeddingUsage,
  type Profile,
} from "./embedding.ts";
import { AppError, appError } from "./errors.ts";
import type { StructuralRepresentation } from "./representation.ts";
import { representationVersion } from "./representation.ts";

export { embeddingIdentityHash };

export { searchNativeCandidates as searchVectorCandidates } from "./vector-search.ts";

export const indexSchemaVersion = 3;

const ExistingFileRows = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    content_hash: Schema.String,
    language: Schema.Literal("typescript"),
    parse_status: Schema.Literals(["current", "degraded", "stale"]),
    symbol_count: Schema.Int,
  }),
);

const SymbolRows = Schema.Array(
  Schema.Struct({
    file_path: Schema.String,
    symbol_key: Schema.String,
    qualified_name: Schema.String,
    kind: Schema.String,
    start_byte: Schema.Int,
    end_byte: Schema.Int,
    start_row: Schema.Int,
    start_column: Schema.Int,
    end_row: Schema.Int,
    end_column: Schema.Int,
    token_count: Schema.Int,
    strict_hash: Schema.String,
    normalized_hash: Schema.String,
    ordered_token_hashes: Schema.Uint8Array,
    qgram_hashes: Schema.Uint8Array,
    embedding_hash: Schema.String,
  }),
);

const ProfileRows = Schema.Array(
  Schema.Struct({
    singleton: Schema.Int,
    embedding_identity: Schema.String,
    provider: Schema.NonEmptyString,
    model: Schema.NonEmptyString,
    dimensions: Schema.Int,
    language: Schema.Literal("typescript"),
    embedding_representation: Schema.Int,
    detector_version: Schema.Int,
    semantic_threshold: Schema.Finite,
    calibration_state: Schema.Literals(["calibrated", "uncalibrated"]),
    complete: Schema.Int,
    usage_requests: Schema.Int,
    usage_inputs: Schema.Int,
    usage_input_tokens: Schema.Int,
    usage_duration_ms: Schema.Int,
  }),
);

const VectorRows = Schema.Array(
  Schema.Struct({
    embedding_identity: Schema.String,
    input_hash: Schema.String,
    dimensions: Schema.Int,
    vector: Schema.Uint8Array,
  }),
);

const VersionRows = Schema.Array(Schema.Struct({ user_version: Schema.Int }));

const NameRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const MetadataRows = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }));

const ColumnRows = Schema.Array(
  Schema.Struct({ table_name: Schema.String, columns: Schema.String }),
);

const IntegrityRows = Schema.Array(Schema.Struct({ invalid: Schema.Int }));

const CountRows = Schema.Array(Schema.Struct({ count: Schema.Int }));

const PresentRows = Schema.Array(Schema.Struct({ present: Schema.Int }));

const VectorHashRows = Schema.Array(
  Schema.Struct({ input_hash: Schema.String, dimensions: Schema.Int }),
);

const hashPattern = /^[0-9a-f]{64}$/;

const zeroUsage: EmbeddingUsage = { requests: 0, inputs: 0, inputTokens: 0, durationMs: 0 };

const invalidIndex = () => appError("index_invalid", "The Index contains invalid data.");

const isAppError = Schema.is(AppError);

export interface FileRecord {
  readonly path: string;
  readonly contentHash: string;
  readonly parseStatus: "current" | "degraded" | "stale";
  readonly symbols: ReadonlyArray<StructuralRepresentation>;
}

export interface IndexWork {
  readonly files: {
    readonly indexed: number;
    readonly reused: number;
    readonly removed: number;
  };
  readonly symbols: {
    readonly indexed: number;
    readonly reused: number;
    readonly removed: number;
  };
}

export interface IndexIdentity {
  readonly configHash: string;
  readonly grammarManifestSha256: string;
  readonly detectorVersion: number;
  readonly structuralPolicyVersion: number;
}

export interface CurrentFile {
  readonly path: string;
  readonly contentHash: string;
}

export interface IndexedFile {
  readonly contentHash: string;
  readonly parseStatus: "current" | "degraded" | "stale";
  readonly symbolCount: number;
}

export interface ActiveProfile extends Profile {
  readonly identityHash: string;
  readonly complete: boolean;
  readonly usage: EmbeddingUsage;
}

export interface IndexSnapshot {
  readonly files: ReadonlyMap<string, IndexedFile>;
  readonly symbols: ReadonlyArray<IndexedSymbol>;
  readonly profile?: ActiveProfile;
  readonly vectors: ReadonlyMap<string, Float32Array>;
}

export interface IndexSession {
  readonly activateProfile: (profile: Profile) => Effect.Effect<ReadonlySet<string>, AppError>;
  readonly updateIndex: (
    currentFiles: ReadonlyArray<CurrentFile>,
    replacements: ReadonlyArray<FileRecord>,
  ) => Effect.Effect<IndexWork, AppError>;
  readonly persistEmbeddingBatch: (
    profile: Profile,
    batch: EmbeddedBatch,
  ) => Effect.Effect<{ readonly indexed: number; readonly reused: number }, AppError>;
  readonly completeProfile: (
    profile: Profile,
  ) => Effect.Effect<{ readonly removed: number }, AppError>;
}

type ExistingFileRow = (typeof ExistingFileRows.Type)[number];

type SymbolRow = (typeof SymbolRows.Type)[number];

type ProfileRow = (typeof ProfileRows.Type)[number];

type VectorRow = (typeof VectorRows.Type)[number];

type VersionRow = (typeof VersionRows.Type)[number];

type NameRow = (typeof NameRows.Type)[number];

type MetadataRow = (typeof MetadataRows.Type)[number];

type ColumnRow = (typeof ColumnRows.Type)[number];

type IntegrityRow = (typeof IntegrityRows.Type)[number];

type CountRow = (typeof CountRows.Type)[number];

type PresentRow = (typeof PresentRows.Type)[number];

type VectorHashRow = (typeof VectorHashRows.Type)[number];

const emptySnapshot = (): IndexSnapshot => ({ files: new Map(), symbols: [], vectors: new Map() });

export const profileMatches = (left: ActiveProfile, right: Profile) =>
  left.identityHash === embeddingIdentityHash(right) &&
  left.detector === right.detector &&
  left.semanticThreshold === right.semanticThreshold &&
  left.calibration === right.calibration;

const decodeProfileRows = Effect.fn("Index.decodeProfileRows")(function* (
  rows: ReadonlyArray<ProfileRow>,
) {
  const decoded = yield* Schema.decodeEffect(ProfileRows)(rows).pipe(Effect.mapError(invalidIndex));

  if (decoded.length > 1) return yield* invalidIndex();

  const row = decoded[0];

  if (row === undefined) return undefined;

  if (
    row.singleton !== 1 ||
    row.dimensions <= 0 ||
    row.embedding_representation <= 0 ||
    row.detector_version <= 0 ||
    row.semantic_threshold < 0 ||
    row.semantic_threshold > 1 ||
    ![0, 1].includes(row.complete) ||
    [row.usage_requests, row.usage_inputs, row.usage_input_tokens, row.usage_duration_ms].some(
      (value) => value < 0,
    )
  ) {
    return yield* invalidIndex();
  }

  const profile: ActiveProfile = {
    identityHash: row.embedding_identity,
    provider: row.provider,
    model: row.model,
    dimensions: row.dimensions,
    language: row.language,
    representation: row.embedding_representation,
    detector: row.detector_version,
    semanticThreshold: row.semantic_threshold,
    calibration: row.calibration_state,
    complete: row.complete === 1,
    usage: {
      requests: row.usage_requests,
      inputs: row.usage_inputs,
      inputTokens: row.usage_input_tokens,
      durationMs: row.usage_duration_ms,
    },
  };

  if (
    !hashPattern.test(profile.identityHash) ||
    profile.identityHash !== embeddingIdentityHash(profile)
  ) {
    return yield* invalidIndex();
  }

  return profile;
});

const readProfile = Effect.fn("Index.readProfile")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ProfileRow>`SELECT * FROM profile`;

  return yield* decodeProfileRows(rows);
});

const readValidatedIndex = Effect.fn("Index.readValidated")(function* (
  indexPath: string,
  identity: IndexIdentity,
) {
  const read = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const versions = yield* sql<VersionRow>`PRAGMA user_version`;

    const decodedVersions = yield* Schema.decodeEffect(VersionRows)(versions).pipe(
      Effect.mapError(invalidIndex),
    );

    if (decodedVersions[0]?.user_version !== indexSchemaVersion) {
      return yield* appError(
        "index_incompatible",
        "The existing Index has an unsupported schema version. Run antisprawl index.",
      );
    }

    const names = yield* sql<NameRow>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;

    const decodedNames = yield* Schema.decodeEffect(NameRows)(names).pipe(
      Effect.mapError(invalidIndex),
    );

    if (
      decodedNames.map((row) => row.name).join(",") !== "files,metadata,profile,symbols,vectors"
    ) {
      return yield* appError("index_incompatible", "The existing Index schema is incompatible.");
    }

    const columnRows = yield* sql<ColumnRow>`
      SELECT 'files' AS table_name, group_concat(name, ',') AS columns
      FROM pragma_table_info('files')
      UNION ALL
      SELECT 'metadata', group_concat(name, ',') FROM pragma_table_info('metadata')
      UNION ALL
      SELECT 'profile', group_concat(name, ',') FROM pragma_table_info('profile')
      UNION ALL
      SELECT 'symbols', group_concat(name, ',') FROM pragma_table_info('symbols')
      UNION ALL
      SELECT 'vectors', group_concat(name, ',') FROM pragma_table_info('vectors')
      ORDER BY table_name
    `;

    const columns = yield* Schema.decodeEffect(ColumnRows)(columnRows).pipe(
      Effect.mapError(invalidIndex),
    );

    if (
      columns.map(({ table_name, columns }) => `${table_name}:${columns}`).join("|") !==
      "files:path,content_hash,language,parse_status,symbol_count|metadata:key,value|profile:singleton,embedding_identity,provider,model,dimensions,language,embedding_representation,detector_version,semantic_threshold,calibration_state,complete,usage_requests,usage_inputs,usage_input_tokens,usage_duration_ms|symbols:file_path,symbol_key,qualified_name,kind,start_byte,end_byte,start_row,start_column,end_row,end_column,token_count,strict_hash,normalized_hash,ordered_token_hashes,qgram_hashes,embedding_hash|vectors:embedding_identity,input_hash,dimensions,vector"
    ) {
      return yield* appError("index_incompatible", "The existing Index schema is incompatible.");
    }

    const metadataRows = yield* sql<MetadataRow>`SELECT key, value FROM metadata ORDER BY key`;

    const decodedMetadata = yield* Schema.decodeEffect(MetadataRows)(metadataRows).pipe(
      Effect.mapError(invalidIndex),
    );

    if (
      decodedMetadata.map(({ key }) => key).join(",") !==
      "config_sha256,detector_version,grammar_manifest_sha256,representation_version,structural_policy_version"
    ) {
      return yield* appError("index_incompatible", "The existing Index metadata is incompatible.");
    }

    const metadata = new Map(decodedMetadata.map((row) => [row.key, row.value]));

    if (
      metadata.get("representation_version") !== String(representationVersion) ||
      metadata.get("grammar_manifest_sha256") !== identity.grammarManifestSha256 ||
      metadata.get("config_sha256") !== identity.configHash ||
      metadata.get("detector_version") !== String(identity.detectorVersion) ||
      metadata.get("structural_policy_version") !== String(identity.structuralPolicyVersion)
    ) {
      return yield* appError(
        "index_incompatible",
        "The existing Index provenance does not match this Project. Run antisprawl index.",
      );
    }

    const integrityRows = yield* sql<IntegrityRow>`
      SELECT CASE WHEN
        EXISTS (
          SELECT 1 FROM files
          WHERE symbol_count != (SELECT COUNT(*) FROM symbols WHERE file_path = files.path)
        ) OR EXISTS (
          SELECT 1 FROM symbols
          LEFT JOIN files ON files.path = symbols.file_path
          WHERE files.path IS NULL
        )
      THEN 1 ELSE 0 END AS invalid
    `;

    const integrity = yield* Schema.decodeEffect(IntegrityRows)(integrityRows).pipe(
      Effect.mapError(invalidIndex),
    );

    if (integrity[0]?.invalid !== 0) return yield* invalidIndex();

    const fileRows = yield* sql<ExistingFileRow>`
      SELECT path, content_hash, language, parse_status, symbol_count FROM files
    `;

    const symbolRows = yield* sql<SymbolRow>`
      SELECT file_path, symbol_key, qualified_name, kind, start_byte, end_byte,
        start_row, start_column, end_row, end_column, token_count, strict_hash,
        normalized_hash, ordered_token_hashes, qgram_hashes, embedding_hash
      FROM symbols
      ORDER BY file_path, symbol_key
    `;

    const vectorRows = yield* sql<VectorRow>`
      SELECT embedding_identity, input_hash, dimensions, vector FROM vectors
    `;

    const files = yield* Schema.decodeEffect(ExistingFileRows)(fileRows).pipe(
      Effect.mapError(invalidIndex),
    );

    const symbols = yield* Schema.decodeEffect(SymbolRows)(symbolRows).pipe(
      Effect.mapError(invalidIndex),
    );

    const vectors = yield* Schema.decodeEffect(VectorRows)(vectorRows).pipe(
      Effect.mapError(invalidIndex),
    );

    const profile = yield* readProfile();

    if (
      files.some((file) => file.symbol_count < 0) ||
      symbols.some(
        (symbol) =>
          !hashPattern.test(symbol.strict_hash) ||
          !hashPattern.test(symbol.normalized_hash) ||
          !hashPattern.test(symbol.embedding_hash) ||
          symbol.ordered_token_hashes.byteLength % 32 !== 0 ||
          symbol.qgram_hashes.byteLength % 32 !== 0 ||
          symbol.start_byte < 0 ||
          symbol.end_byte < symbol.start_byte ||
          symbol.start_row < 0 ||
          symbol.start_column < 0 ||
          symbol.end_row < symbol.start_row ||
          symbol.end_column < 0 ||
          symbol.token_count < 0,
      )
    ) {
      return yield* invalidIndex();
    }

    const activeVectors = new Map<string, Float32Array>();

    for (const row of vectors) {
      if (
        !hashPattern.test(row.embedding_identity) ||
        !hashPattern.test(row.input_hash) ||
        row.dimensions <= 0 ||
        row.vector.byteLength !== row.dimensions * 4
      ) {
        return yield* invalidIndex();
      }

      const decoded = decodeVector(row.vector, row.dimensions);

      if (
        [...decoded].some((value) => !Number.isFinite(value)) ||
        [...decoded].every((value) => value === 0)
      ) {
        return yield* invalidIndex();
      }

      if (profile?.identityHash === row.embedding_identity) {
        if (row.dimensions !== profile.dimensions) return yield* invalidIndex();
        activeVectors.set(row.input_hash, decoded);
      }
    }

    if (
      profile?.complete &&
      symbols.some(
        (symbol) =>
          symbol.token_count >= structuralPolicy.minimumTokens &&
          !activeVectors.has(symbol.embedding_hash),
      )
    ) {
      return yield* invalidIndex();
    }

    return {
      files: new Map(
        files.map((row) => [
          row.path,
          {
            contentHash: row.content_hash,
            parseStatus: row.parse_status,
            symbolCount: row.symbol_count,
          },
        ]),
      ),
      symbols: symbols.map((row): IndexedSymbol => ({
        path: row.file_path,
        language: "typescript",
        key: row.symbol_key,
        qualifiedName: row.qualified_name,
        kind: row.kind,
        startByte: row.start_byte,
        endByte: row.end_byte,
        startRow: row.start_row,
        startColumn: row.start_column,
        endRow: row.end_row,
        endColumn: row.end_column,
        tokenCount: row.token_count,
        strictHash: row.strict_hash,
        normalizedHash: row.normalized_hash,
        orderedTokenHashes: row.ordered_token_hashes,
        qgramHashes: row.qgram_hashes,
        embeddingHash: row.embedding_hash,
      })),
      profile,
      vectors: activeVectors,
    } satisfies IndexSnapshot;
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath, readonly: true, disableWAL: true })),
    Effect.scoped,
    Effect.mapError((error) =>
      isAppError(error)
        ? error
        : appError("index_unreadable", "The existing Index cannot be read safely."),
    ),
  );

  return yield* read;
});

export const readIndex = Effect.fn("Index.read")(function* (
  indexPath: string,
  identity: IndexIdentity,
  required = true,
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(indexPath))) {
    if (required) return yield* appError("index_missing", "No Index exists. Run antisprawl index.");

    return emptySnapshot();
  }

  return yield* readValidatedIndex(indexPath, identity);
});

export const readIndexForBaseline = Effect.fn("Index.readForBaseline")(function* (
  indexPath: string,
  identity: IndexIdentity,
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(indexPath))) {
    return { snapshot: emptySnapshot(), needsReplacement: false } as const;
  }

  return yield* readValidatedIndex(indexPath, identity).pipe(
    Effect.map((snapshot) => ({ snapshot, needsReplacement: false }) as const),
    Effect.catchIf(
      (error) => isAppError(error) && error.code === "index_incompatible",
      () => Effect.succeed({ snapshot: emptySnapshot(), needsReplacement: true } as const),
    ),
  );
});

const initializeSchema = Effect.fn("Index.initializeSchema")(function* (identity: IndexIdentity) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL CHECK (language = 'typescript'),
      parse_status TEXT NOT NULL CHECK (parse_status IN ('current', 'degraded', 'stale')),
      symbol_count INTEGER NOT NULL CHECK (symbol_count >= 0)
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS symbols (
      file_path TEXT NOT NULL,
      symbol_key TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      start_byte INTEGER NOT NULL,
      end_byte INTEGER NOT NULL,
      start_row INTEGER NOT NULL,
      start_column INTEGER NOT NULL,
      end_row INTEGER NOT NULL,
      end_column INTEGER NOT NULL,
      token_count INTEGER NOT NULL CHECK (token_count >= 0),
      strict_hash TEXT NOT NULL,
      normalized_hash TEXT NOT NULL,
      ordered_token_hashes BLOB NOT NULL,
      qgram_hashes BLOB NOT NULL,
      embedding_hash TEXT NOT NULL,
      PRIMARY KEY (file_path, symbol_key),
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS profile (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      embedding_identity TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      language TEXT NOT NULL CHECK (language = 'typescript'),
      embedding_representation INTEGER NOT NULL CHECK (embedding_representation > 0),
      detector_version INTEGER NOT NULL CHECK (detector_version > 0),
      semantic_threshold REAL NOT NULL CHECK (semantic_threshold >= 0 AND semantic_threshold <= 1),
      calibration_state TEXT NOT NULL CHECK (calibration_state IN ('calibrated', 'uncalibrated')),
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      usage_requests INTEGER NOT NULL CHECK (usage_requests >= 0),
      usage_inputs INTEGER NOT NULL CHECK (usage_inputs >= 0),
      usage_input_tokens INTEGER NOT NULL CHECK (usage_input_tokens >= 0),
      usage_duration_ms INTEGER NOT NULL CHECK (usage_duration_ms >= 0)
    ) STRICT
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS vectors (
      embedding_identity TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      vector BLOB NOT NULL,
      PRIMARY KEY (embedding_identity, input_hash)
    ) STRICT
  `;
  yield* sql`PRAGMA user_version = 3`;
  yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('config_sha256', ${identity.configHash})`;
  yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('grammar_manifest_sha256', ${identity.grammarManifestSha256})`;
  yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('representation_version', ${String(representationVersion)})`;
  yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('detector_version', ${String(identity.detectorVersion)})`;
  yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('structural_policy_version', ${String(identity.structuralPolicyVersion)})`;
});

const replaceFile = Effect.fn("Index.replaceFile")(function* (file: FileRecord) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM symbols WHERE file_path = ${file.path}`;
  yield* sql`
    INSERT OR REPLACE INTO files (path, content_hash, language, parse_status, symbol_count)
    VALUES (${file.path}, ${file.contentHash}, 'typescript', ${file.parseStatus}, ${file.symbols.length})
  `;

  for (const symbol of file.symbols) {
    yield* sql`
      INSERT INTO symbols (
        file_path, symbol_key, qualified_name, kind, start_byte, end_byte, start_row,
        start_column, end_row, end_column, token_count, strict_hash, normalized_hash,
        ordered_token_hashes, qgram_hashes, embedding_hash
      ) VALUES (
        ${file.path}, ${symbol.key}, ${symbol.qualifiedName}, ${symbol.kind},
        ${symbol.startByte}, ${symbol.endByte}, ${symbol.startRow}, ${symbol.startColumn},
        ${symbol.endRow}, ${symbol.endColumn}, ${symbol.tokenCount}, ${symbol.strictHash},
        ${symbol.normalizedHash}, ${symbol.orderedTokenHashes}, ${symbol.qgramHashes},
        ${symbol.embeddingHash}
      )
    `;
  }
});

const updateIndexInSession = Effect.fn("Index.updateInSession")(function* (
  identity: IndexIdentity,
  previous: IndexSnapshot,
  currentFiles: ReadonlyArray<CurrentFile>,
  replacements: ReadonlyArray<FileRecord>,
  expectedFiles?: ReadonlyMap<string, IndexedFile>,
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`PRAGMA foreign_keys = ON`;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* initializeSchema(identity);

      if (expectedFiles !== undefined) {
        const rows = yield* sql<ExistingFileRow>`
          SELECT path, content_hash, language, parse_status, symbol_count FROM files
        `;

        const files = yield* Schema.decodeEffect(ExistingFileRows)(rows).pipe(
          Effect.mapError(invalidIndex),
        );

        if (
          files.length !== expectedFiles.size ||
          files.some((file) => {
            const expected = expectedFiles.get(file.path);

            return (
              expected === undefined ||
              expected.contentHash !== file.content_hash ||
              expected.parseStatus !== file.parse_status ||
              expected.symbolCount !== file.symbol_count
            );
          })
        ) {
          return yield* appError(
            "index_currentness_changed",
            "Index currentness changed during processing.",
          );
        }
      }

      const currentPaths = new Set(currentFiles.map((file) => file.path));
      const replacementByPath = new Map(replacements.map((file) => [file.path, file]));
      const removesFiles = [...previous.files.keys()].some((path) => !currentPaths.has(path));

      if (replacements.length > 0 || removesFiles) {
        yield* sql`UPDATE profile SET complete = 0 WHERE singleton = 1`;
      }

      let indexedFiles = 0;
      let reusedFiles = 0;
      let indexedSymbols = 0;
      let reusedSymbols = 0;
      let removedFiles = 0;
      let removedSymbols = 0;

      for (const current of currentFiles) {
        const prior = previous.files.get(current.path);
        const replacement = replacementByPath.get(current.path);

        if (replacement !== undefined) {
          const priorNames = previous.symbols.filter((symbol) => symbol.path === current.path);
          const nextNames = new Map<string, number>();

          for (const symbol of replacement.symbols) {
            nextNames.set(symbol.qualifiedName, (nextNames.get(symbol.qualifiedName) ?? 0) + 1);
          }

          for (const symbol of priorNames) {
            const remaining = nextNames.get(symbol.qualifiedName) ?? 0;

            if (remaining === 0) removedSymbols += 1;
            else nextNames.set(symbol.qualifiedName, remaining - 1);
          }

          yield* replaceFile(replacement);
          indexedFiles += 1;
          indexedSymbols += replacement.symbols.length;
          continue;
        }

        if (prior?.contentHash !== current.contentHash) {
          return yield* appError(
            "index_currentness_changed",
            "Index currentness changed during processing.",
          );
        }

        reusedFiles += 1;
        reusedSymbols += prior.symbolCount;
      }

      for (const [path, file] of previous.files) {
        if (currentPaths.has(path)) continue;

        yield* sql`DELETE FROM files WHERE path = ${path}`;
        removedFiles += 1;
        removedSymbols += file.symbolCount;
      }

      return {
        files: { indexed: indexedFiles, reused: reusedFiles, removed: removedFiles },
        symbols: { indexed: indexedSymbols, reused: reusedSymbols, removed: removedSymbols },
      } satisfies IndexWork;
    }),
  );
});

export const updateIndex = Effect.fn("Index.update")(function* (
  indexPath: string,
  identity: IndexIdentity,
  currentFiles: ReadonlyArray<CurrentFile>,
  replacements: ReadonlyArray<FileRecord>,
) {
  const previous = yield* readIndex(indexPath, identity, false);
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  yield* fs
    .makeDirectory(paths.dirname(indexPath), { recursive: true })
    .pipe(
      Effect.mapError(() => appError("index_unwritable", "The Index directory cannot be created.")),
    );

  return yield* updateIndexInSession(identity, previous, currentFiles, replacements).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath, disableWAL: true })),
    Effect.scoped,
    Effect.mapError((error) =>
      isAppError(error)
        ? error
        : appError("index_update_failed", "The Index could not be updated safely."),
    ),
  );
});

export const replaceIndex = Effect.fn("Index.replace")(function* (
  indexPath: string,
  identity: IndexIdentity,
  currentFiles: ReadonlyArray<CurrentFile>,
  replacements: ReadonlyArray<FileRecord>,
) {
  const fs = yield* FileSystem.FileSystem;
  const replacementPath = `${indexPath}.replacement-${process.pid}`;

  if (yield* fs.exists(replacementPath)) yield* fs.remove(replacementPath);

  return yield* Effect.gen(function* () {
    const work = yield* updateIndex(replacementPath, identity, currentFiles, replacements);

    yield* fs
      .rename(replacementPath, indexPath)
      .pipe(
        Effect.mapError(() => appError("index_update_failed", "The Index could not be replaced.")),
      );

    return work;
  }).pipe(
    Effect.ensuring(
      fs.exists(replacementPath).pipe(
        Effect.flatMap((exists) => (exists ? fs.remove(replacementPath) : Effect.void)),
        Effect.ignore,
      ),
    ),
  );
});

const activateProfileInSession = Effect.fn("Index.activateProfile")(function* (profile: Profile) {
  const sql = yield* SqlClient.SqlClient;
  const identityHash = embeddingIdentityHash(profile);

  yield* sql.withTransaction(
    Effect.gen(function* () {
      const previous = yield* readProfile();
      const usage = previous?.identityHash === identityHash ? previous.usage : zeroUsage;

      yield* sql`
        INSERT OR REPLACE INTO profile (
          singleton, embedding_identity, provider, model, dimensions, language,
          embedding_representation, detector_version, semantic_threshold, calibration_state,
          complete, usage_requests, usage_inputs, usage_input_tokens, usage_duration_ms
        ) VALUES (
          1, ${identityHash}, ${profile.provider}, ${profile.model}, ${profile.dimensions},
          ${profile.language}, ${profile.representation}, ${profile.detector},
          ${profile.semanticThreshold}, ${profile.calibration}, 0, ${usage.requests},
          ${usage.inputs}, ${usage.inputTokens}, ${usage.durationMs}
        )
      `;
    }),
  );

  const rows = yield* sql<VectorHashRow>`
    SELECT input_hash, dimensions FROM vectors WHERE embedding_identity = ${identityHash}
  `;

  const hashes = yield* Schema.decodeEffect(VectorHashRows)(rows).pipe(
    Effect.mapError(invalidIndex),
  );

  if (
    hashes.some(
      ({ input_hash, dimensions }) =>
        !hashPattern.test(input_hash) || dimensions !== profile.dimensions,
    )
  ) {
    return yield* invalidIndex();
  }

  return new Set(hashes.map(({ input_hash }) => input_hash));
});

const validateBatch = (profile: Profile, batch: EmbeddedBatch) => {
  const seen = new Set<string>();

  for (const item of batch.vectors) {
    if (!hashPattern.test(item.hash) || seen.has(item.hash)) {
      throw appError(
        "embedding_response_order_invalid",
        "The embedding batch contains invalid identities.",
      );
    }

    seen.add(item.hash);

    if (item.vector.length !== profile.dimensions) {
      throw appError(
        "embedding_vector_dimensions_invalid",
        "The embedding vector has unexpected dimensions.",
      );
    }

    if ([...item.vector].some((value) => !Number.isFinite(value))) {
      throw appError(
        "embedding_vector_non_finite",
        "The embedding vector contains a non-finite value.",
      );
    }

    if ([...item.vector].every((value) => value === 0)) {
      throw appError("embedding_vector_zero", "The embedding vector is zero.");
    }
  }

  if (
    ![
      batch.usage.requests,
      batch.usage.inputs,
      batch.usage.inputTokens,
      batch.usage.durationMs,
    ].every((value) => Number.isInteger(value) && value >= 0)
  ) {
    throw appError("embedding_usage_invalid", "The embedding provider returned invalid usage.");
  }
};

const persistEmbeddingBatchInSession = Effect.fn("Index.persistEmbeddingBatch")(function* (
  profile: Profile,
  batch: EmbeddedBatch,
) {
  yield* Effect.try({
    try: () => validateBatch(profile, batch),
    catch: (error) =>
      isAppError(error)
        ? error
        : appError("embedding_batch_invalid", "The embedding batch is invalid."),
  });

  const sql = yield* SqlClient.SqlClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const active = yield* readProfile();

      if (active === undefined || !profileMatches(active, profile)) {
        return yield* appError(
          "embedding_profile_changed",
          "The active Profile changed during indexing.",
        );
      }

      let indexed = 0;
      let reused = 0;

      for (const item of batch.vectors) {
        const rows = yield* sql<PresentRow>`
          SELECT 1 AS present FROM vectors
          WHERE embedding_identity = ${active.identityHash} AND input_hash = ${item.hash}
        `;

        const present = yield* Schema.decodeEffect(PresentRows)(rows).pipe(
          Effect.mapError(invalidIndex),
        );

        if (present.length === 0) indexed += 1;
        else reused += 1;

        yield* sql`
          INSERT OR REPLACE INTO vectors (embedding_identity, input_hash, dimensions, vector)
          VALUES (
            ${active.identityHash}, ${item.hash}, ${profile.dimensions},
            ${encodeVector([...item.vector])}
          )
        `;
      }

      yield* sql`
        UPDATE profile SET
          usage_requests = usage_requests + ${batch.usage.requests},
          usage_inputs = usage_inputs + ${batch.usage.inputs},
          usage_input_tokens = usage_input_tokens + ${batch.usage.inputTokens},
          usage_duration_ms = usage_duration_ms + ${batch.usage.durationMs}
        WHERE singleton = 1
      `;

      return { indexed, reused };
    }),
  );
});

const completeProfileInSession = Effect.fn("Index.completeProfile")(function* (profile: Profile) {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const active = yield* readProfile();

      if (active === undefined || !profileMatches(active, profile)) {
        return yield* appError(
          "embedding_profile_changed",
          "The active Profile changed during indexing.",
        );
      }

      const missingRows = yield* sql<CountRow>`
        SELECT COUNT(*) AS count FROM symbols
        WHERE token_count >= ${structuralPolicy.minimumTokens}
          AND NOT EXISTS (
            SELECT 1 FROM vectors
            WHERE vectors.embedding_identity = ${active.identityHash}
              AND vectors.input_hash = symbols.embedding_hash
          )
      `;

      const missing = yield* Schema.decodeEffect(CountRows)(missingRows).pipe(
        Effect.mapError(invalidIndex),
      );

      if (missing[0]?.count !== 0) {
        return yield* appError(
          "embedding_index_incomplete",
          "The active Profile still has missing vectors.",
        );
      }

      const removedRows = yield* sql<PresentRow>`
        DELETE FROM vectors
        WHERE embedding_identity != ${active.identityHash}
           OR NOT EXISTS (
             SELECT 1 FROM symbols WHERE symbols.embedding_hash = vectors.input_hash
           )
        RETURNING 1 AS present
      `;

      const removed = yield* Schema.decodeEffect(PresentRows)(removedRows).pipe(
        Effect.mapError(invalidIndex),
      );

      yield* sql`UPDATE profile SET complete = 1 WHERE singleton = 1`;

      return { removed: removed.length };
    }),
  );
});

export const withIndexSession = <A, E, R>(
  indexPath: string,
  identity: IndexIdentity,
  snapshot: IndexSnapshot,
  use: (session: IndexSession) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const write = <T>(effect: Effect.Effect<T, unknown, SqlClient.SqlClient>) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((error) =>
          isAppError(error)
            ? error
            : appError("index_update_failed", "The Index could not be updated safely."),
        ),
      );

    return yield* use({
      activateProfile: (profile) => write(activateProfileInSession(profile)),
      updateIndex: (currentFiles, replacements) =>
        write(updateIndexInSession(identity, snapshot, currentFiles, replacements, snapshot.files)),
      persistEmbeddingBatch: (profile, batch) =>
        write(persistEmbeddingBatchInSession(profile, batch)),
      completeProfile: (profile) => write(completeProfileInSession(profile)),
    });
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath, disableWAL: true })),
    Effect.scoped,
    Effect.withSpan("Index.withSession"),
  );
