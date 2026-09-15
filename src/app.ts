import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { appError } from "./errors.ts";
import { indexSchemaVersion, updateIndex, type FileRecord } from "./index.ts";
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
  const files: Array<FileRecord> = [];
  const diagnostics = [...project.diagnostics];
  let failedFiles = 0;

  for (const sourcePath of sourcePaths) {
    const source = yield* fs
      .readFileString(paths.join(project.root, sourcePath))
      .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${sourcePath}.`)));

    const parsed = yield* parseTypeScript(grammar, source);

    if (parsed.hasError) {
      failedFiles += 1;
      diagnostics.push({
        severity: "warning",
        code: "source_parse_degraded",
        path: sourcePath,
      });
    }

    files.push({
      path: sourcePath,
      contentHash: sha256(source),
      parseStatus: parsed.hasError ? "degraded" : "current",
      symbols: parsed.symbols.map(representSymbol),
    });
  }

  const indexPath = paths.join(project.root, ".antisprawl/index.sqlite");

  const work = yield* updateIndex(
    indexPath,
    { configHash: project.configHash, grammar: grammar.provenance },
    files,
  );

  return {
    protocolVersion: 1,
    command: "index",
    coverage: {
      status: failedFiles === 0 ? "complete" : "degraded",
      files: {
        total: files.length,
        current: files.length - failedFiles,
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
