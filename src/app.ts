import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { appError } from "./errors.ts";
import {
  indexSchemaVersion,
  readIndexedFiles,
  updateIndex,
  type CurrentFile,
  type FileRecord,
} from "./index.ts";
import {
  loadBundledTypeScriptGrammar,
  parseTypeScript,
  type GrammarProvenance,
} from "./language.ts";
import { discoverSourcePaths, resolveProject, type Diagnostic } from "./project.ts";
import { representationVersion, representSymbol } from "./representation.ts";

interface IndexOutput {
  readonly protocolVersion: 1;
  readonly command: "index";
  readonly coverage: {
    readonly status: "complete" | "degraded";
    readonly files: {
      readonly total: number;
      readonly current: number;
      readonly failed: number;
    };
  };
  readonly work: {
    readonly files: { readonly indexed: number; readonly reused: number };
    readonly symbols: { readonly indexed: number; readonly reused: number };
  };
  readonly provenance: {
    readonly bun: string;
    readonly indexSchema: number;
    readonly representation: number;
    readonly grammar: GrammarProvenance;
  };
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly findings: readonly [];
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const indexProject = Effect.fn("App.indexProject")(function* (startingDirectory: string) {
  const project = yield* resolveProject(startingDirectory);
  const grammar = yield* loadBundledTypeScriptGrammar();
  const sourcePaths = yield* discoverSourcePaths(project);
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const indexPath = paths.join(project.root, ".antisprawl/index.sqlite");
  const identity = { configHash: project.configHash, grammar: grammar.provenance };
  const indexedFiles = yield* readIndexedFiles(indexPath, identity);
  const currentFiles: Array<CurrentFile> = [];
  const replacements: Array<FileRecord> = [];
  const diagnostics = [...project.diagnostics];
  let failedFiles = 0;

  for (const sourcePath of sourcePaths) {
    const source = yield* fs
      .readFileString(paths.join(project.root, sourcePath))
      .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${sourcePath}.`)));

    const contentHash = sha256(source);
    const previous = indexedFiles.get(sourcePath);

    currentFiles.push({ path: sourcePath, contentHash });

    if (previous?.contentHash === contentHash) {
      if (previous.parseStatus === "degraded") {
        failedFiles += 1;
        diagnostics.push({
          severity: "warning",
          code: "source_parse_degraded",
          path: sourcePath,
        });
      }

      continue;
    }

    const parsed = yield* parseTypeScript(grammar, source);

    if (parsed.hasError) {
      failedFiles += 1;
      diagnostics.push({
        severity: "warning",
        code: "source_parse_degraded",
        path: sourcePath,
      });
    }

    replacements.push({
      path: sourcePath,
      contentHash,
      parseStatus: parsed.hasError ? "degraded" : "current",
      symbols: parsed.symbols.map(representSymbol),
    });
  }

  for (const current of currentFiles) {
    const source = yield* fs
      .readFileString(paths.join(project.root, current.path))
      .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${current.path}.`)));

    if (sha256(source) !== current.contentHash) {
      return yield* Effect.fail(
        appError("source_changed_during_index", `${current.path} changed during indexing.`),
      );
    }
  }

  const work = yield* updateIndex(indexPath, identity, currentFiles, replacements);

  return {
    protocolVersion: 1,
    command: "index",
    coverage: {
      status: failedFiles === 0 ? "complete" : "degraded",
      files: {
        total: currentFiles.length,
        current: currentFiles.length - failedFiles,
        failed: failedFiles,
      },
    },
    work,
    provenance: {
      bun: process.versions.bun,
      indexSchema: indexSchemaVersion,
      representation: representationVersion,
      grammar: grammar.provenance,
    },
    diagnostics,
    findings: [],
  } satisfies IndexOutput;
});
