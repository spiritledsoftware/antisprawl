import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  detectProbableDuplicates,
  detectorVersion,
  structuralPolicy,
  type Finding,
  type IndexedSymbol,
} from "./detector.ts";
import {
  applicationCosine,
  configuredEmbeddingProvider,
  embeddingBatchSize,
  encodeVector,
  runEmbeddingBatch,
  type EmbeddingProvider,
  type EmbeddingUsage,
  type Profile,
} from "./embedding.ts";
import { AppError, appError } from "./errors.ts";
import {
  embeddingIdentityHash,
  indexSchemaVersion,
  profileMatches,
  readIndex,
  readIndexForBaseline,
  replaceIndex,
  searchVectorCandidates,
  updateIndex,
  withIndexSession,
  type CurrentFile,
  type FileRecord,
  type IndexIdentity,
  type IndexSession,
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
  readonly status: "complete" | "partial" | "degraded";
  readonly files: {
    readonly total: number;
    readonly current: number;
    readonly failed: number;
  };
}

interface VectorWork {
  readonly indexed: number;
  readonly reused: number;
  readonly removed: number;
}

interface CommandWork extends IndexWork {
  readonly vectors: VectorWork;
}

interface ProfileProvenance {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly language: "typescript";
  readonly embeddingRepresentation: number;
  readonly detector: number;
  readonly semanticThreshold: number;
  readonly calibration: "calibrated" | "uncalibrated";
}

interface Provenance {
  readonly bun: string;
  readonly indexSchema: number;
  readonly representation: number;
  readonly grammar: GrammarProvenance;
  readonly detector: number;
  readonly structuralPolicy: typeof structuralPolicy;
  readonly profile?: ProfileProvenance;
}

interface Analysis {
  readonly mode: "structural_only" | "semantic";
  readonly vectorSearch?: "application_exact" | "sqlite_vec";
}

interface CommandOutput {
  readonly protocolVersion: 1;
  readonly command: "index" | "check";
  readonly analysis: Analysis;
  readonly coverage: Coverage;
  readonly work: CommandWork;
  readonly usage?: { readonly embedding: EmbeddingUsage };
  readonly provenance: Provenance;
  readonly diagnostics: ReadonlyArray<Diagnostic>;
  readonly findings: ReadonlyArray<Finding>;
}

interface DryRunOutput {
  readonly protocolVersion: 1;
  readonly command: "index";
  readonly dryRun: true;
  readonly profile?: ProfileProvenance;
  readonly preview: {
    readonly files: number;
    readonly eligibleSymbols: number;
    readonly inputBytes: number;
    readonly vectors: { readonly required: number; readonly reused: number };
  };
  readonly diagnostics: ReadonlyArray<Diagnostic>;
}

interface Context {
  readonly project: Project;
  readonly grammar: ResolvedGrammar;
  readonly indexPath: string;
  readonly identity: IndexIdentity;
  readonly provider?: EmbeddingProvider;
}

interface EmbeddingWork {
  readonly vectors: VectorWork;
  readonly usage?: EmbeddingUsage;
}

const zeroVectorWork = (): VectorWork => ({ indexed: 0, reused: 0, removed: 0 });

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
    provider: configuredEmbeddingProvider(project.embedding?.provider),
  } satisfies Context;
});

const profileProvenance = (profile: Profile): ProfileProvenance => ({
  provider: profile.provider,
  model: profile.model,
  dimensions: profile.dimensions,
  language: profile.language,
  embeddingRepresentation: profile.representation,
  detector: profile.detector,
  semanticThreshold: profile.semanticThreshold,
  calibration: profile.calibration,
});

const provenance = (context: Context): Provenance => ({
  bun: process.versions.bun,
  indexSchema: indexSchemaVersion,
  representation: representationVersion,
  grammar: context.grammar.provenance,
  detector: detectorVersion,
  structuralPolicy,
  profile: context.provider === undefined ? undefined : profileProvenance(context.provider.profile),
});

export const dryRunIndex = Effect.fn("App.dryRunIndex")(function* (startingDirectory: string) {
  const context = yield* loadContext(startingDirectory);
  const baseline = yield* readIndexForBaseline(context.indexPath, context.identity);
  const sourcePaths = yield* discoverSourcePaths(context.project);
  const diagnostics: Array<Diagnostic> = [...context.project.diagnostics];
  const representations: Array<StructuralRepresentation> = [];

  for (const path of sourcePaths) {
    const source = yield* sourceText(context.project.root, path);
    const file = yield* representFile(context, path, source, sha256(source));

    representations.push(...file.symbols);
    addDegradedDiagnostic(file.parseStatus, path, diagnostics);
  }

  const eligible = representations.filter(
    (symbol) =>
      symbol.tokenCount >= structuralPolicy.minimumTokens && symbol.embeddingInput !== undefined,
  );

  const inputByHash = new Map(
    eligible.map((symbol) => [symbol.embeddingHash, symbol.embeddingInput!] as const),
  );

  const identityMatches =
    context.provider !== undefined && embeddingIdentityMatches(baseline.snapshot, context.provider);

  let reused = 0;
  let inputBytes = 0;

  for (const [hash, input] of inputByHash) {
    if (identityMatches && baseline.snapshot.vectors.has(hash)) reused += 1;
    else inputBytes += new TextEncoder().encode(input).byteLength;
  }

  return {
    protocolVersion: 1,
    command: "index",
    dryRun: true,
    profile:
      context.provider === undefined ? undefined : profileProvenance(context.provider.profile),
    preview: {
      files: sourcePaths.length,
      eligibleSymbols: eligible.length,
      inputBytes,
      vectors: { required: inputByHash.size - reused, reused },
    },
    diagnostics,
  } satisfies DryRunOutput;
});

const asIndexed = (path: string, symbol: StructuralRepresentation): IndexedSymbol => ({
  path,
  language: "typescript",
  ...symbol,
});

const completedProfileMatches = (active: IndexSnapshot["profile"], profile: Profile) =>
  active !== undefined && active.complete && profileMatches(active, profile);

const coverageFor = (
  currentPaths: ReadonlyArray<string>,
  snapshot: IndexSnapshot,
  profile: Profile | undefined,
): Coverage => {
  let parseFailures = 0;
  let missingVectors = 0;

  const vectorIdentityMatches =
    profile === undefined || snapshot.profile?.identityHash === embeddingIdentityHash(profile);

  for (const path of currentPaths) {
    const file = snapshot.files.get(path);

    if (file?.parseStatus !== "current") {
      parseFailures += 1;
      continue;
    }

    if (
      profile !== undefined &&
      snapshot.symbols.some(
        (symbol) =>
          symbol.path === path &&
          symbol.tokenCount >= structuralPolicy.minimumTokens &&
          (!vectorIdentityMatches || !snapshot.vectors.has(symbol.embeddingHash)),
      )
    ) {
      missingVectors += 1;
    }
  }

  const failed = parseFailures + missingVectors;

  const profileIncomplete =
    profile !== undefined && !completedProfileMatches(snapshot.profile, profile);

  return {
    status:
      parseFailures > 0
        ? "degraded"
        : missingVectors > 0 || profileIncomplete
          ? "partial"
          : "complete",
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

const ensureSourcesUnchanged = Effect.fn("App.ensureSourcesUnchanged")(function* (
  root: string,
  files: ReadonlyArray<CurrentFile>,
) {
  for (const file of files) {
    const source = yield* sourceText(root, file.path);

    if (sha256(source) !== file.contentHash) {
      return yield* appError(
        "source_changed_during_index",
        `${file.path} changed during indexing.`,
      );
    }
  }
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

const addUsage = (left: EmbeddingUsage, right: EmbeddingUsage): EmbeddingUsage => ({
  requests: left.requests + right.requests,
  inputs: left.inputs + right.inputs,
  inputTokens: left.inputTokens + right.inputTokens,
  durationMs: left.durationMs + right.durationMs,
});

const writeBatchTrace = Effect.fn("App.writeBatchTrace")(function* (
  batch: number,
  hashes: ReadonlyArray<string>,
) {
  const tracePath = Bun.env.ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE;

  if (tracePath === undefined) return;

  const fs = yield* FileSystem.FileSystem;

  yield* fs
    .writeFileString(tracePath, `${batch}\n${hashes.join("\n")}\n`)
    .pipe(
      Effect.mapError(() =>
        appError("embedding_trace_failed", "The acceptance trace could not be written."),
      ),
    );

  if (Bun.env.ANTISPRAW_ACCEPTANCE_PAUSE_AFTER_BATCH === String(batch)) {
    const pauseMs = Number(Bun.env.ANTISPRAW_ACCEPTANCE_PAUSE_AFTER_BATCH_MS ?? 60_000);

    yield* Effect.sleep(Number.isFinite(pauseMs) && pauseMs >= 0 ? pauseMs : 60_000);
  }
});

const embedRequired = Effect.fn("App.embedRequired")(function* (
  session: IndexSession,
  provider: EmbeddingProvider,
  required: ReadonlyArray<IndexedSymbol>,
  represented: ReadonlyArray<FileRecord>,
) {
  const availableHashes = yield* session.activateProfile(provider.profile);

  const requiredHashes = [
    ...new Set(
      required.flatMap((symbol) =>
        symbol.tokenCount >= structuralPolicy.minimumTokens ? [symbol.embeddingHash] : [],
      ),
    ),
  ].sort();

  const inputByHash = new Map(
    represented.flatMap((file) =>
      file.symbols.flatMap((symbol) =>
        symbol.embeddingInput === undefined ? [] : [[symbol.embeddingHash, symbol.embeddingInput]],
      ),
    ),
  );

  const missing = requiredHashes.filter((hash) => !availableHashes.has(hash));
  let usage: EmbeddingUsage = { requests: 0, inputs: 0, inputTokens: 0, durationMs: 0 };
  let indexed = 0;
  let reused = requiredHashes.length - missing.length;
  let batchNumber = 0;

  for (let offset = 0; offset < missing.length; offset += embeddingBatchSize) {
    const hashes = missing.slice(offset, offset + embeddingBatchSize);

    const requests = hashes.map((hash, index) => {
      const input = inputByHash.get(hash);

      if (input === undefined) {
        throw appError(
          "embedding_input_unavailable",
          "Embedding input is unavailable. Run antisprawl index.",
        );
      }

      return { index, hash, input };
    });

    const batch = yield* runEmbeddingBatch(provider, requests);

    const persisted = yield* session.persistEmbeddingBatch(provider.profile, batch);

    indexed += persisted.indexed;
    reused += persisted.reused;
    usage = addUsage(usage, batch.usage);
    batchNumber += 1;
    yield* writeBatchTrace(batchNumber, hashes);
  }

  return {
    vectors: { indexed, reused, removed: 0 },
    usage: usage.requests === 0 ? undefined : usage,
  } satisfies EmbeddingWork;
});

const completeEmbedding = Effect.fn("App.completeEmbedding")(function* (
  session: IndexSession,
  provider: EmbeddingProvider,
  work: EmbeddingWork,
) {
  const completed = yield* session.completeProfile(provider.profile);

  return {
    ...work,
    vectors: { ...work.vectors, removed: completed.removed },
  } satisfies EmbeddingWork;
});

const embeddingIdentityMatches = (snapshot: IndexSnapshot, provider: EmbeddingProvider) =>
  snapshot.profile?.identityHash === embeddingIdentityHash(provider.profile);

const outputWork = (structural: IndexWork, embedding: EmbeddingWork): CommandWork => ({
  ...structural,
  vectors: embedding.vectors,
});

const nativeSearch = Effect.fn("App.nativeSearch")(function* (
  context: Context,
  snapshot: IndexSnapshot,
  querySymbols: ReadonlyArray<IndexedSymbol>,
) {
  const provider = context.provider;
  const profile = snapshot.profile;

  if (provider === undefined || profile === undefined) {
    return { path: "application_exact" as const };
  }

  const queries: Array<{
    readonly symbol: IndexedSymbol | undefined;
    readonly vector: Float32Array;
  }> = querySymbols.flatMap((symbol) => {
    const vector = snapshot.vectors.get(symbol.embeddingHash);

    return vector === undefined ? [] : [{ symbol, vector }];
  });

  if (queries.length === 0) {
    const first = snapshot.vectors.values().next().value;

    if (first !== undefined) queries.push({ symbol: undefined, vector: first });
  }

  const candidateHashesByQuery = new Map<string, ReadonlySet<string>>();

  for (const { symbol, vector } of queries) {
    const result = yield* searchVectorCandidates(
      context.indexPath,
      profile.identityHash,
      encodeVector([...vector]),
      provider.profile.dimensions,
      Bun.env,
      1 - provider.profile.semanticThreshold + 0.000_001,
    ).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (candidates) => candidates,
      }),
    );

    if (result === undefined) return { path: "application_exact" as const };

    const expected = new Set(
      [...snapshot.vectors].flatMap(([hash, candidate]) =>
        applicationCosine(vector, candidate) >= provider.profile.semanticThreshold ? [hash] : [],
      ),
    );

    const candidates = new Set(result.filter((hash) => expected.has(hash)));

    if (candidates.size !== expected.size) return { path: "application_exact" as const };

    if (symbol !== undefined) candidateHashesByQuery.set(symbol.embeddingHash, candidates);
  }

  return { path: "sqlite_vec" as const, candidateHashesByQuery };
});

const semanticAnalysis = (
  semantic: boolean,
  vectorSearch: "application_exact" | "sqlite_vec" = "application_exact",
): Analysis => (semantic ? { mode: "semantic", vectorSearch } : { mode: "structural_only" });

export const indexProject = Effect.fn("App.indexProject")(function* (startingDirectory: string) {
  const context = yield* loadContext(startingDirectory);
  const baseline = yield* readIndexForBaseline(context.indexPath, context.identity);
  const sourcePaths = yield* discoverSourcePaths(context.project);
  const currentFiles: Array<CurrentFile> = [];
  const replacementByPath = new Map<string, FileRecord>();
  const diagnostics: Array<Diagnostic> = [...context.project.diagnostics];

  const forceRepresentation =
    context.provider !== undefined &&
    (!embeddingIdentityMatches(baseline.snapshot, context.provider) ||
      !baseline.snapshot.profile?.complete);

  for (const sourcePath of sourcePaths) {
    const source = yield* sourceText(context.project.root, sourcePath);
    const contentHash = sha256(source);
    const previous = baseline.snapshot.files.get(sourcePath);

    currentFiles.push({ path: sourcePath, contentHash });

    if (
      !forceRepresentation &&
      previous?.contentHash === contentHash &&
      previous.parseStatus !== "stale"
    ) {
      addDegradedDiagnostic(previous.parseStatus, sourcePath, diagnostics);
      continue;
    }

    const replacement = yield* representFile(context, sourcePath, source, contentHash);

    replacementByPath.set(sourcePath, replacement);
    addDegradedDiagnostic(replacement.parseStatus, sourcePath, diagnostics);
  }

  yield* ensureSourcesUnchanged(context.project.root, currentFiles);

  const replacements = [...replacementByPath.values()];

  const structuralWork = baseline.needsReplacement
    ? yield* replaceIndex(context.indexPath, context.identity, currentFiles, replacements)
    : yield* updateIndex(context.indexPath, context.identity, currentFiles, replacements);

  let embeddingWork: EmbeddingWork = { vectors: zeroVectorWork() };

  if (context.provider !== undefined) {
    const structural = yield* readIndex(context.indexPath, context.identity);

    embeddingWork = yield* withIndexSession(
      context.indexPath,
      context.identity,
      structural,
      (session) =>
        Effect.gen(function* () {
          const work = yield* embedRequired(
            session,
            context.provider!,
            structural.symbols,
            replacements,
          );

          yield* ensureSourcesUnchanged(context.project.root, currentFiles);

          return yield* completeEmbedding(session, context.provider!, work);
        }),
    );
  }

  const snapshot = yield* readIndex(context.indexPath, context.identity);

  const search =
    context.provider === undefined
      ? undefined
      : yield* nativeSearch(context, snapshot, snapshot.symbols.slice(0, 1));

  if (search?.path === "application_exact" && context.provider !== undefined) {
    diagnostics.push({ severity: "warning", code: "vector_search_fallback" });
  }

  return {
    protocolVersion: 1,
    command: "index",
    analysis: semanticAnalysis(context.provider !== undefined, search?.path),
    coverage: coverageFor(sourcePaths, snapshot, context.provider?.profile),
    work: outputWork(structuralWork, embeddingWork),
    usage: embeddingWork.usage === undefined ? undefined : { embedding: embeddingWork.usage },
    provenance: provenance(context),
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

const prospectiveSymbols = (
  previous: IndexSnapshot,
  currentPaths: ReadonlySet<string>,
  replacements: ReadonlyMap<string, FileRecord>,
): ReadonlyArray<IndexedSymbol> => [
  ...previous.symbols.filter(
    (symbol) => currentPaths.has(symbol.path) && !replacements.has(symbol.path),
  ),
  ...[...replacements.values()].flatMap((file) =>
    file.parseStatus === "stale" ? [] : file.symbols.map((symbol) => asIndexed(file.path, symbol)),
  ),
];

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

  const edited = [...replacementByPath.values()].flatMap((replacement) =>
    replacement.parseStatus === "stale"
      ? []
      : editedSymbols(replacement.path, replacement.symbols, previous),
  );

  let embeddingWork: EmbeddingWork = { vectors: zeroVectorWork() };
  let embeddingError: AppError | undefined;

  const canEmbed =
    context.provider !== undefined &&
    completedProfileMatches(previous.profile, context.provider.profile);

  if (context.provider !== undefined && !canEmbed) {
    diagnostics.push({
      severity: "warning",
      code: "semantic_index_partial",
      message: "Run antisprawl index.",
    });
  }

  const persistStructural = Effect.fnUntraced(function* (session?: IndexSession) {
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

    const replacements = [...replacementByPath.values()];

    const structuralWork =
      session === undefined
        ? yield* updateIndex(context.indexPath, context.identity, currentFiles, replacements)
        : yield* session.updateIndex(currentFiles, replacements);

    return { sortedCurrentPaths, structuralWork };
  });

  const persisted =
    context.provider !== undefined && canEmbed
      ? yield* withIndexSession(context.indexPath, context.identity, previous, (session) =>
          Effect.gen(function* () {
            const required = prospectiveSymbols(previous, currentPaths, replacementByPath);

            const result = yield* embedRequired(session, context.provider!, required, [
              ...replacementByPath.values(),
            ]).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: (work) => ({ work }),
              }),
            );

            if ("error" in result) {
              if (!Schema.is(AppError)(result.error)) {
                return yield* appError(
                  "index_update_failed",
                  "The Index could not be updated safely.",
                );
              }

              embeddingError = result.error;
              diagnostics.push({ severity: "warning", code: result.error.code });
            } else {
              embeddingWork = result.work;
            }

            const persisted = yield* persistStructural(session);

            if (embeddingError === undefined) {
              embeddingWork = yield* completeEmbedding(session, context.provider!, embeddingWork);
            }

            return persisted;
          }),
        )
      : yield* persistStructural();

  const { sortedCurrentPaths, structuralWork } = persisted;

  const current = yield* readIndex(context.indexPath, context.identity);

  const semantic =
    context.provider !== undefined &&
    embeddingError === undefined &&
    completedProfileMatches(current.profile, context.provider.profile);

  const search = semantic ? yield* nativeSearch(context, current, edited) : undefined;

  const detection = detectProbableDuplicates(
    edited,
    current.symbols,
    semantic && context.provider !== undefined
      ? {
          threshold: context.provider.profile.semanticThreshold,
          vectors: current.vectors,
          candidateHashesByQuery:
            search?.path === "sqlite_vec" ? search.candidateHashesByQuery : undefined,
        }
      : undefined,
  );

  if (search?.path === "application_exact" && semantic) {
    diagnostics.push({ severity: "warning", code: "vector_search_fallback" });
  }

  diagnostics.push(...detection.diagnostics);

  return {
    protocolVersion: 1,
    command: "check",
    analysis: semanticAnalysis(semantic, search?.path),
    coverage: coverageFor(sortedCurrentPaths, current, context.provider?.profile),
    work: outputWork(structuralWork, embeddingWork),
    usage: embeddingWork.usage === undefined ? undefined : { embedding: embeddingWork.usage },
    provenance: provenance(context),
    diagnostics,
    findings: detection.findings,
  } satisfies CommandOutput;
});
