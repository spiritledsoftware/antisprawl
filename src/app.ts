import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  detectProbableDuplicates,
  detectorVersion,
  structuralPolicy,
  type Finding,
  type IndexedSymbol,
} from "./detector.ts";
import { appError } from "./errors.ts";
import {
  indexSchemaVersion,
  readIndex,
  readIndexForBaseline,
  replaceIndex,
  updateIndex,
  type CurrentFile,
  type FileRecord,
  type IndexIdentity,
  type IndexSnapshot,
  type IndexWork,
} from "./index.ts";
import {
  loadBundledTypeScriptGrammar,
  parseTypeScript,
  type GrammarProvenance,
  type ResolvedGrammar,
} from "./language.ts";
import {
  discoverSourcePaths,
  resolveNamedSourcePaths,
  resolveProject,
  type Diagnostic,
  type Project,
} from "./project.ts";
import {
  representationVersion,
  representSymbol,
  type StructuralRepresentation,
} from "./representation.ts";

interface Coverage {
  readonly status: "complete" | "degraded";
  readonly files: {
    readonly total: number;
    readonly current: number;
    readonly failed: number;
  };
}

interface Provenance {
  readonly bun: string;
  readonly indexSchema: number;
  readonly representation: number;
  readonly grammar: GrammarProvenance;
  readonly detector: number;
  readonly structuralPolicy: typeof structuralPolicy;
}

interface CommandOutput {
  readonly protocolVersion: 1;
  readonly command: "index" | "check";
  readonly coverage: Coverage;
  readonly work: IndexWork;
  readonly provenance: Provenance;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly findings: ReadonlyArray<Finding>;
}

interface Context {
  readonly project: Project;
  readonly grammar: ResolvedGrammar;
  readonly indexPath: string;
  readonly identity: IndexIdentity;
}

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const loadContext = Effect.fn("App.loadContext")(function* (startingDirectory: string) {
  const project = yield* resolveProject(startingDirectory);
  const grammar = yield* loadBundledTypeScriptGrammar();
  const paths = yield* Path.Path;

  return {
    project,
    grammar,
    indexPath: paths.join(project.root, ".antisprawl/index.sqlite"),
    identity: {
      configHash: project.configHash,
      grammarManifestSha256: grammar.provenance.manifestSha256,
      detectorVersion,
      structuralPolicyVersion: structuralPolicy.version,
    },
  } satisfies Context;
});

const provenance = (grammar: Context["grammar"]): Provenance => ({
  bun: process.versions.bun,
  indexSchema: indexSchemaVersion,
  representation: representationVersion,
  grammar: grammar.provenance,
  detector: detectorVersion,
  structuralPolicy,
});

const asIndexed = (path: string, symbol: StructuralRepresentation): IndexedSymbol => ({
  path,
  language: "typescript",
  ...symbol,
});

const coverageFor = (
  currentPaths: ReadonlyArray<string>,
  previous: IndexSnapshot,
  replacements: ReadonlyMap<string, FileRecord>,
): Coverage => {
  let failed = 0;

  for (const path of currentPaths) {
    const status = replacements.get(path)?.parseStatus ?? previous.files.get(path)?.parseStatus;

    if (status !== "current") failed += 1;
  }

  return {
    status: failed === 0 ? "complete" : "degraded",
    files: { total: currentPaths.length, current: currentPaths.length - failed, failed },
  };
};

const sourceText = Effect.fn("App.readSource")(function* (root: string, sourcePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  return yield* fs
    .readFileString(paths.join(root, sourcePath))
    .pipe(Effect.mapError(() => appError("source_unreadable", `Cannot read ${sourcePath}.`)));
});

const representFile = Effect.fn("App.representFile")(function* (
  context: Context,
  path: string,
  source: string,
  contentHash: string,
) {
  const parsed = yield* parseTypeScript(context.grammar, source);

  return {
    path,
    contentHash,
    parseStatus: parsed.hasError ? "degraded" : "current",
    symbols: parsed.symbols.map(representSymbol),
  } satisfies FileRecord;
});

const addDegradedDiagnostic = (
  status: FileRecord["parseStatus"] | undefined,
  path: string,
  diagnostics: Array<Diagnostic>,
) => {
  if (status === "degraded") {
    diagnostics.push({ severity: "warning", code: "source_parse_degraded", path });
  }
};

export const indexProject = Effect.fn("App.indexProject")(function* (startingDirectory: string) {
  const context = yield* loadContext(startingDirectory);
  const baseline = yield* readIndexForBaseline(context.indexPath, context.identity);
  const sourcePaths = yield* discoverSourcePaths(context.project);
  const currentFiles: Array<CurrentFile> = [];
  const replacementByPath = new Map<string, FileRecord>();
  const diagnostics: Array<Diagnostic> = [...context.project.diagnostics];

  for (const sourcePath of sourcePaths) {
    const source = yield* sourceText(context.project.root, sourcePath);
    const contentHash = sha256(source);
    const previous = baseline.snapshot.files.get(sourcePath);

    currentFiles.push({ path: sourcePath, contentHash });

    if (previous?.contentHash === contentHash && previous.parseStatus !== "stale") {
      addDegradedDiagnostic(previous.parseStatus, sourcePath, diagnostics);
      continue;
    }

    const replacement = yield* representFile(context, sourcePath, source, contentHash);

    replacementByPath.set(sourcePath, replacement);
    addDegradedDiagnostic(replacement.parseStatus, sourcePath, diagnostics);
  }

  for (const current of currentFiles) {
    const source = yield* sourceText(context.project.root, current.path);

    if (sha256(source) !== current.contentHash) {
      return yield* appError(
        "source_changed_during_index",
        `${current.path} changed during indexing.`,
      );
    }
  }

  const replacements = [...replacementByPath.values()];

  const work = baseline.needsReplacement
    ? yield* replaceIndex(context.indexPath, context.identity, currentFiles, replacements)
    : yield* updateIndex(context.indexPath, context.identity, currentFiles, replacements);

  return {
    protocolVersion: 1,
    command: "index",
    coverage: coverageFor(sourcePaths, baseline.snapshot, replacementByPath),
    work,
    provenance: provenance(context.grammar),
    diagnostics,
    findings: [],
  } satisfies CommandOutput;
});

const editedSymbols = (
  path: string,
  current: ReadonlyArray<StructuralRepresentation>,
  previous: IndexSnapshot,
) => {
  const previousByName = new Map<string, Array<IndexedSymbol>>();

  for (const symbol of previous.symbols) {
    if (symbol.path !== path) continue;

    const matches = previousByName.get(symbol.qualifiedName) ?? [];
    matches.push(symbol);
    previousByName.set(symbol.qualifiedName, matches);
  }

  const currentCounts = new Map<string, number>();

  for (const symbol of current) {
    currentCounts.set(symbol.qualifiedName, (currentCounts.get(symbol.qualifiedName) ?? 0) + 1);
  }

  return current.flatMap((symbol) => {
    if (currentCounts.get(symbol.qualifiedName) !== 1) return [];

    const prior = previousByName.get(symbol.qualifiedName);

    return prior?.length === 1 && prior[0]?.strictHash === symbol.strictHash
      ? []
      : [asIndexed(path, symbol)];
  });
};

export const checkProject = Effect.fn("App.checkProject")(function* (
  startingDirectory: string,
  pathArguments: ReadonlyArray<string>,
) {
  const context = yield* loadContext(startingDirectory);
  const previous = yield* readIndex(context.indexPath, context.identity);
  const named = pathArguments.length > 0;

  const requested = named
    ? yield* resolveNamedSourcePaths(context.project, startingDirectory, pathArguments)
    : (yield* discoverSourcePaths(context.project)).map((path) => ({ path, exists: true }));

  for (const source of requested) {
    if (!source.exists && !previous.files.has(source.path)) {
      return yield* appError("source_missing", `Source path ${source.path} does not exist.`);
    }
  }

  const currentPaths = new Set(named ? previous.files.keys() : requested.map(({ path }) => path));

  for (const source of requested) {
    if (source.exists) currentPaths.add(source.path);
    else currentPaths.delete(source.path);
  }

  const replacementByPath = new Map<string, FileRecord>();
  const diagnostics: Array<Diagnostic> = [...context.project.diagnostics];

  for (const requestedPath of requested) {
    if (!requestedPath.exists) continue;

    const source = yield* sourceText(context.project.root, requestedPath.path);
    const contentHash = sha256(source);
    const prior = previous.files.get(requestedPath.path);

    if (prior?.contentHash === contentHash && prior.parseStatus !== "stale") {
      addDegradedDiagnostic(prior.parseStatus, requestedPath.path, diagnostics);
      continue;
    }

    const replacement = yield* representFile(context, requestedPath.path, source, contentHash);

    replacementByPath.set(requestedPath.path, replacement);
    addDegradedDiagnostic(replacement.parseStatus, requestedPath.path, diagnostics);
  }

  for (const [path, replacement] of replacementByPath) {
    const finalSource = yield* sourceText(context.project.root, path);
    const finalHash = sha256(finalSource);

    if (finalHash === replacement.contentHash) continue;

    replacementByPath.set(path, {
      path,
      contentHash: finalHash,
      parseStatus: "stale",
      symbols: [],
    });
    diagnostics.push({ severity: "warning", code: "source_changed_during_check", path });
  }

  const sortedCurrentPaths = [...currentPaths].sort();

  const currentFiles = sortedCurrentPaths.map((path): CurrentFile => {
    const contentHash =
      replacementByPath.get(path)?.contentHash ?? previous.files.get(path)?.contentHash;

    if (contentHash === undefined) throw new Error(`Missing current hash for ${path}.`);

    return { path, contentHash };
  });

  const edited = [...replacementByPath.values()].flatMap((replacement) =>
    replacement.parseStatus === "stale"
      ? []
      : editedSymbols(replacement.path, replacement.symbols, previous),
  );

  const work = yield* updateIndex(context.indexPath, context.identity, currentFiles, [
    ...replacementByPath.values(),
  ]);

  const current = yield* readIndex(context.indexPath, context.identity);
  const detection = detectProbableDuplicates(edited, current.symbols);

  diagnostics.push(...detection.diagnostics);

  return {
    protocolVersion: 1,
    command: "check",
    coverage: coverageFor(sortedCurrentPaths, previous, replacementByPath),
    work,
    provenance: provenance(context.grammar),
    diagnostics,
    findings: detection.findings,
  } satisfies CommandOutput;
});
