import * as Schema from "effect/Schema";

const Counts = Schema.Struct({
  indexed: Schema.Int,
  reused: Schema.Int,
  removed: Schema.Int,
});

export const Coverage = Schema.Struct({
  status: Schema.Literals(["complete", "partial", "degraded"]),
  files: Schema.Struct({
    total: Schema.Int,
    current: Schema.Int,
    failed: Schema.Int,
  }),
});

export type Coverage = typeof Coverage.Type;

export const Diagnostic = Schema.Struct({
  severity: Schema.Literal("warning"),
  code: Schema.String,
  path: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

export type Diagnostic = typeof Diagnostic.Type;

const FindingLocation = Schema.Struct({
  path: Schema.String,
  qualifiedName: Schema.String,
  range: Schema.Struct({
    start: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
    end: Schema.Struct({ line: Schema.Int, column: Schema.Int }),
  }),
});

export const Finding = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("probable_duplicate"),
  language: Schema.Literal("typescript"),
  edited: FindingLocation,
  candidate: FindingLocation,
  structuralEvidence: Schema.Struct({
    strictHashEqual: Schema.Boolean,
    normalizedHashEqual: Schema.Boolean,
    qgramSimilarity: Schema.Finite,
    orderedTokenSimilarity: Schema.Finite,
  }),
  semanticEvidence: Schema.optional(
    Schema.Struct({
      cosineSimilarity: Schema.Finite,
    }),
  ),
  guidance: Schema.String,
});

export type Finding = typeof Finding.Type;

const EmbeddingUsage = Schema.Struct({
  requests: Schema.Int,
  inputs: Schema.Int,
  inputTokens: Schema.Int,
  durationMs: Schema.Int,
});

const ProfileProvenance = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  dimensions: Schema.Int,
  language: Schema.Literal("typescript"),
  embeddingRepresentation: Schema.Int,
  detector: Schema.Int,
  semanticThreshold: Schema.Finite,
  calibration: Schema.Literals(["calibrated", "uncalibrated"]),
});

const GrammarProvenance = Schema.Struct({
  language: Schema.Literal("typescript"),
  runtime: Schema.String,
  parserCommit: Schema.String,
  parserAbi: Schema.Int,
  wasmSha256: Schema.String,
  querySha256: Schema.String,
  manifestSha256: Schema.String,
});

const Provenance = Schema.Struct({
  bun: Schema.String,
  indexSchema: Schema.Int,
  representation: Schema.Int,
  grammar: GrammarProvenance,
  detector: Schema.Int,
  structuralPolicy: Schema.Struct({
    version: Schema.Int,
    minimumTokens: Schema.Int,
    qgramSimilarity: Schema.Finite,
    orderedTokenSimilarity: Schema.Finite,
    maximumOrderedCells: Schema.Int,
  }),
  profile: Schema.optional(ProfileProvenance),
});

const Analysis = Schema.Struct({
  mode: Schema.Literals(["structural_only", "semantic"]),
  vectorSearch: Schema.optional(Schema.Literals(["application_exact", "sqlite_vec"])),
});

export const CommandOutput = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  command: Schema.Literals(["index", "check"]),
  analysis: Analysis,
  coverage: Coverage,
  work: Schema.Struct({
    files: Counts,
    symbols: Counts,
    vectors: Counts,
  }),
  usage: Schema.optional(Schema.Struct({ embedding: EmbeddingUsage })),
  provenance: Provenance,
  diagnostics: Schema.Array(Diagnostic),
  findings: Schema.Array(Finding),
});

export type CommandOutput = typeof CommandOutput.Type;

export const DryRunOutput = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  command: Schema.Literal("index"),
  dryRun: Schema.Literal(true),
  profile: Schema.optional(ProfileProvenance),
  preview: Schema.Struct({
    files: Schema.Int,
    eligibleSymbols: Schema.Int,
    inputBytes: Schema.Int,
    vectors: Schema.Struct({
      required: Schema.Int,
      reused: Schema.Int,
    }),
  }),
  diagnostics: Schema.Array(Diagnostic),
});

export type DryRunOutput = typeof DryRunOutput.Type;

export const ProtocolOutput = Schema.Union([CommandOutput, DryRunOutput]);

export type ProtocolOutput = typeof ProtocolOutput.Type;

export const ProtocolJson = Schema.fromJsonString(ProtocolOutput);

export const encodeProtocolJson = Schema.encodeUnknownEffect(ProtocolJson);
