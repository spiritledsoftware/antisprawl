import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { IndexedSymbol } from "./detector.ts";
import { AppError, appError } from "./errors.ts";
import type { StructuralRepresentation } from "./representation.ts";
import { representationVersion } from "./representation.ts";

export const indexSchemaVersion = 2;

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
  }),
);

const VersionRows = Schema.Array(Schema.Struct({ user_version: Schema.Int }));

const NameRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const MetadataRows = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }));

const ColumnRows = Schema.Array(
  Schema.Struct({ table_name: Schema.String, columns: Schema.String }),
);

const SymbolIntegrityRows = Schema.Array(Schema.Struct({ invalid: Schema.Int }));

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

export interface IndexSnapshot {
  readonly files: ReadonlyMap<string, IndexedFile>;
  readonly symbols: ReadonlyArray<IndexedSymbol>;
}

type ExistingFileRow = (typeof ExistingFileRows.Type)[number];

type SymbolRow = (typeof SymbolRows.Type)[number];

type VersionRow = (typeof VersionRows.Type)[number];

type NameRow = (typeof NameRows.Type)[number];

type MetadataRow = (typeof MetadataRows.Type)[number];

const emptySnapshot = (): IndexSnapshot => ({ files: new Map(), symbols: [] });

const readValidatedIndex = Effect.fn("Index.readValidated")(function* (
  indexPath: string,
  identity: IndexIdentity,
) {
  const read = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const versions = yield* sql<VersionRow>`PRAGMA user_version`;

    const decodedVersions = yield* Schema.decodeEffect(VersionRows)(versions).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
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
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    if (decodedNames.map((row) => row.name).join(",") !== "files,metadata,symbols") {
      return yield* appError("index_incompatible", "The existing Index schema is incompatible.");
    }

    const columnRows = yield* sql<{ table_name: string; columns: string }>`
      SELECT 'files' AS table_name, group_concat(name, ',') AS columns
      FROM pragma_table_info('files')
      UNION ALL
      SELECT 'metadata', group_concat(name, ',')
      FROM pragma_table_info('metadata')
      UNION ALL
      SELECT 'symbols', group_concat(name, ',')
      FROM pragma_table_info('symbols')
      ORDER BY table_name
    `;

    const columns = yield* Schema.decodeEffect(ColumnRows)(columnRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    if (
      columns.map(({ table_name, columns }) => `${table_name}:${columns}`).join("|") !==
      "files:path,content_hash,language,parse_status,symbol_count|metadata:key,value|symbols:file_path,symbol_key,qualified_name,kind,start_byte,end_byte,start_row,start_column,end_row,end_column,token_count,strict_hash,normalized_hash,ordered_token_hashes,qgram_hashes"
    ) {
      return yield* appError("index_incompatible", "The existing Index schema is incompatible.");
    }

    const metadataRows = yield* sql<MetadataRow>`SELECT key, value FROM metadata ORDER BY key`;

    const decodedMetadata = yield* Schema.decodeEffect(MetadataRows)(metadataRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
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

    const integrityRows = yield* sql<{ invalid: number }>`
      SELECT CASE WHEN
        EXISTS (
          SELECT 1
          FROM files
          WHERE symbol_count != (
            SELECT COUNT(*) FROM symbols WHERE file_path = files.path
          )
        ) OR EXISTS (
          SELECT 1
          FROM symbols
          LEFT JOIN files ON files.path = symbols.file_path
          WHERE files.path IS NULL
        )
      THEN 1 ELSE 0 END AS invalid
    `;

    const integrity = yield* Schema.decodeEffect(SymbolIntegrityRows)(integrityRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    if (integrity[0]?.invalid !== 0) {
      return yield* appError("index_invalid", "The Index contains invalid data.");
    }

    const fileRows = yield* sql<ExistingFileRow>`
      SELECT path, content_hash, language, parse_status, symbol_count FROM files
    `;

    const symbolRows = yield* sql<SymbolRow>`
      SELECT
        file_path,
        symbol_key,
        qualified_name,
        kind,
        start_byte,
        end_byte,
        start_row,
        start_column,
        end_row,
        end_column,
        token_count,
        strict_hash,
        normalized_hash,
        ordered_token_hashes,
        qgram_hashes
      FROM symbols
      ORDER BY file_path, symbol_key
    `;

    const files = yield* Schema.decodeEffect(ExistingFileRows)(fileRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    const symbols = yield* Schema.decodeEffect(SymbolRows)(symbolRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    const hashPattern = /^[0-9a-f]{64}$/;

    if (
      symbols.some(
        (symbol) =>
          !hashPattern.test(symbol.strict_hash) ||
          !hashPattern.test(symbol.normalized_hash) ||
          symbol.ordered_token_hashes.byteLength % 32 !== 0 ||
          symbol.qgram_hashes.byteLength % 32 !== 0 ||
          symbol.start_byte < 0 ||
          symbol.end_byte < symbol.start_byte ||
          symbol.start_row < 0 ||
          symbol.start_column < 0 ||
          symbol.end_row < symbol.start_row ||
          symbol.end_column < 0,
      )
    ) {
      return yield* appError("index_invalid", "The Index contains invalid data.");
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
      })),
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
    if (required) {
      return yield* appError("index_missing", "No Index exists. Run antisprawl index.");
    }

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
      PRIMARY KEY (file_path, symbol_key),
      FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
    ) STRICT
  `;
  yield* sql`PRAGMA user_version = 2`;
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
        file_path,
        symbol_key,
        qualified_name,
        kind,
        start_byte,
        end_byte,
        start_row,
        start_column,
        end_row,
        end_column,
        token_count,
        strict_hash,
        normalized_hash,
        ordered_token_hashes,
        qgram_hashes
      ) VALUES (
        ${file.path},
        ${symbol.key},
        ${symbol.qualifiedName},
        ${symbol.kind},
        ${symbol.startByte},
        ${symbol.endByte},
        ${symbol.startRow},
        ${symbol.startColumn},
        ${symbol.endRow},
        ${symbol.endColumn},
        ${symbol.tokenCount},
        ${symbol.strictHash},
        ${symbol.normalizedHash},
        ${symbol.orderedTokenHashes},
        ${symbol.qgramHashes}
      )
    `;
  }
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

  const write = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`PRAGMA foreign_keys = ON`;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* initializeSchema(identity);

        const currentPaths = new Set(currentFiles.map((file) => file.path));
        const replacementByPath = new Map(replacements.map((file) => [file.path, file]));
        const previousNameCounts = new Map<string, Map<string, number>>();

        for (const symbol of previous.symbols) {
          const names = previousNameCounts.get(symbol.path) ?? new Map<string, number>();

          names.set(symbol.qualifiedName, (names.get(symbol.qualifiedName) ?? 0) + 1);
          previousNameCounts.set(symbol.path, names);
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
            const replacementNames = new Map<string, number>();

            for (const symbol of replacement.symbols) {
              replacementNames.set(
                symbol.qualifiedName,
                (replacementNames.get(symbol.qualifiedName) ?? 0) + 1,
              );
            }

            for (const [name, count] of previousNameCounts.get(current.path) ?? []) {
              removedSymbols += Math.max(count - (replacementNames.get(name) ?? 0), 0);
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
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath, disableWAL: true })),
    Effect.scoped,
    Effect.mapError((error) =>
      isAppError(error)
        ? error
        : appError("index_update_failed", "The Index could not be updated safely."),
    ),
  );

  return yield* write;
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
