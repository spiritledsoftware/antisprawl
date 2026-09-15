import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AppError, appError } from "./errors.ts";
import type { GrammarProvenance } from "./language.ts";
import type { StructuralRepresentation } from "./representation.ts";
import { representationVersion } from "./representation.ts";

export const indexSchemaVersion = 1;

const ExistingFileRows = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    content_hash: Schema.String,
    symbol_count: Schema.Number,
  }),
);

const VersionRows = Schema.Array(Schema.Struct({ user_version: Schema.Number }));

const NameRows = Schema.Array(Schema.Struct({ name: Schema.String }));

const MetadataRows = Schema.Array(
  Schema.Struct({
    key: Schema.String,
    value: Schema.String,
  }),
);

export interface FileRecord {
  readonly path: string;
  readonly contentHash: string;
  readonly parseStatus: "current" | "degraded";
  readonly symbols: ReadonlyArray<StructuralRepresentation>;
}

export interface IndexWork {
  readonly files: {
    readonly indexed: number;
    readonly reused: number;
  };
  readonly symbols: {
    readonly indexed: number;
    readonly reused: number;
  };
}

interface IndexIdentity {
  readonly configHash: string;
  readonly grammar: GrammarProvenance;
}

interface ExistingFileRow {
  readonly path: string;
  readonly content_hash: string;
  readonly symbol_count: number;
}

interface VersionRow {
  readonly user_version: number;
}

interface NameRow {
  readonly name: string;
}

interface MetadataRow {
  readonly key: string;
  readonly value: string;
}

const inspectExistingIndex = Effect.fn("Index.inspectExisting")(function* (
  indexPath: string,
  identity: IndexIdentity,
) {
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* fs.exists(indexPath))) return;

  const inspect = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const versions = yield* sql<VersionRow>`PRAGMA user_version`;

    const decodedVersions = yield* Schema.decodeUnknownEffect(VersionRows)(versions).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    if (decodedVersions[0]?.user_version !== indexSchemaVersion) {
      return yield* Effect.fail(
        appError("index_incompatible", "The existing Index has an unsupported schema version."),
      );
    }

    const names = yield* sql<NameRow>`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('metadata', 'files', 'symbols')
      ORDER BY name
    `;

    const decodedNames = yield* Schema.decodeUnknownEffect(NameRows)(names).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    if (decodedNames.map((row) => row.name).join(",") !== "files,metadata,symbols") {
      return yield* Effect.fail(
        appError("index_incompatible", "The existing Index schema is incomplete."),
      );
    }

    const metadataRows = yield* sql<MetadataRow>`SELECT key, value FROM metadata`;

    const decodedMetadata = yield* Schema.decodeUnknownEffect(MetadataRows)(metadataRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    const metadata = new Map(decodedMetadata.map((row) => [row.key, row.value]));

    if (
      metadata.get("representation_version") !== String(representationVersion) ||
      metadata.get("grammar_manifest_sha256") !== identity.grammar.manifestSha256 ||
      metadata.get("config_sha256") !== identity.configHash
    ) {
      return yield* Effect.fail(
        appError(
          "index_incompatible",
          "The existing Index provenance does not match this Project.",
        ),
      );
    }
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath, readonly: true, disableWAL: true })),
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof AppError
        ? error
        : appError("index_unreadable", "The existing Index cannot be read safely."),
    ),
  );

  yield* inspect;
});

const initializeSchema = Effect.fn("Index.initializeSchema")(function* (identity: IndexIdentity) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
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
          language TEXT NOT NULL,
          parse_status TEXT NOT NULL CHECK (parse_status IN ('current', 'degraded')),
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
      yield* sql`PRAGMA user_version = 1`;
      yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('config_sha256', ${identity.configHash})`;
      yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('grammar_manifest_sha256', ${identity.grammar.manifestSha256})`;
      yield* sql`INSERT OR REPLACE INTO metadata (key, value) VALUES ('representation_version', ${String(representationVersion)})`;
    }),
  );
});

const replaceFile = Effect.fn("Index.replaceFile")(function* (file: FileRecord) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.withTransaction(
    Effect.gen(function* () {
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
    }),
  );
});

export const updateIndex = Effect.fn("Index.update")(function* (
  indexPath: string,
  identity: IndexIdentity,
  files: ReadonlyArray<FileRecord>,
) {
  yield* inspectExistingIndex(indexPath, identity);

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
    yield* initializeSchema(identity);

    const existingRows = yield* sql<ExistingFileRow>`
      SELECT path, content_hash, symbol_count FROM files
    `;

    const decodedExisting = yield* Schema.decodeUnknownEffect(ExistingFileRows)(existingRows).pipe(
      Effect.mapError(() => appError("index_invalid", "The Index contains invalid data.")),
    );

    const existing = new Map(decodedExisting.map((row) => [row.path, row]));

    const currentPaths = new Set(files.map((file) => file.path));
    let indexedFiles = 0;
    let reusedFiles = 0;
    let indexedSymbols = 0;
    let reusedSymbols = 0;

    for (const file of files) {
      const previous = existing.get(file.path);

      if (previous?.content_hash === file.contentHash) {
        reusedFiles += 1;
        reusedSymbols += previous.symbol_count;
        continue;
      }

      yield* replaceFile(file);
      indexedFiles += 1;
      indexedSymbols += file.symbols.length;
    }

    for (const path of existing.keys()) {
      if (!currentPaths.has(path)) yield* sql`DELETE FROM files WHERE path = ${path}`;
    }

    return {
      files: { indexed: indexedFiles, reused: reusedFiles },
      symbols: { indexed: indexedSymbols, reused: reusedSymbols },
    } satisfies IndexWork;
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename: indexPath })),
    Effect.scoped,
    Effect.mapError((error) =>
      error instanceof AppError
        ? error
        : appError("index_update_failed", "The Index could not be updated safely."),
    ),
  );

  return yield* write;
});
