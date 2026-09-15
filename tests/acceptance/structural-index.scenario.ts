export const structuralIndexScenario = {
  configPath: ".antisprawl/config.jsonc",
  config: `{
  // Absence of embedding means Structural-only mode.
  "version": 1,
  "sources": {
    "include": ["src/**/*.ts"],
    "exclude": [],
  },
}\n`,
  files: {
    "src/jobs.ts": `export interface Job {
  readonly id: string;
  readonly status: "ready" | "queued";
  readonly cancelledAt: string | null;
}

export function collectReadyJobs(jobs: ReadonlyArray<Job>): Array<Job> {
  const ready: Array<Job> = [];
  for (const job of jobs) {
    if (job.status !== "ready") continue;
    if (job.cancelledAt !== null) continue;
    ready.push(job);
  }
  return ready;
}
`,
  },
  index: {
    metadata: [
      {
        key: "config_sha256",
        value: "c4b3a8b48391ca12c10066a7bb608e73ba85ba76656d71b2401b015ee12b28e1",
      },
      {
        key: "grammar_manifest_sha256",
        value: "04472408d1f5ff4ca99ece2a2139354ad7551fe63662811038a2c0bcbd3a7c56",
      },
      { key: "representation_version", value: "1" },
    ],
    files: [
      {
        path: "src/jobs.ts",
        content_hash: "7661c225944b17cde70a2c78653ba3737e159bc9070583fdaa7b2f23e2c558b2",
        language: "typescript",
        parse_status: "current",
        symbol_count: 1,
      },
    ],
    symbols: [
      {
        file_path: "src/jobs.ts",
        symbol_key: "collectReadyJobs\u0000function\u0000134:388",
        qualified_name: "collectReadyJobs",
        kind: "function",
        start_byte: 134,
        end_byte: 388,
        start_row: 6,
        start_column: 7,
        end_row: 14,
        end_column: 1,
        token_count: 54,
        strict_hash: "661ed95f8fa4be49fec8e86c72a3ec5d866d3666e12051658756d1d37c9c34a1",
        normalized_hash: "a8e21aac3623eff04dad35b88d82ee3fd3d8ee3cd7465115d028788648811274",
        ordered_type: "blob",
        ordered_bytes: 2208,
        qgram_type: "blob",
        qgram_bytes: 1856,
      },
    ],
  },
  firstOutput: {
    protocolVersion: 1,
    command: "index",
    coverage: {
      status: "complete",
      files: { total: 1, current: 1, failed: 0 },
    },
    work: {
      files: { indexed: 1, reused: 0 },
      symbols: { indexed: 1, reused: 0 },
    },
    provenance: {
      bun: "1.4.2",
      indexSchema: 1,
      representation: 1,
      grammar: {
        language: "typescript",
        runtime: "0.27.0",
        parserCommit: "75b3874edb2dc714fb1fd77a32013d0f8699989f",
        parserAbi: 14,
        wasmSha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
        querySha256: "19aac740c43842509516d27f857691d83d5db89ee3039d2cdc1290e015789ce0",
        manifestSha256: "04472408d1f5ff4ca99ece2a2139354ad7551fe63662811038a2c0bcbd3a7c56",
      },
    },
    diagnostics: [],
    findings: [],
  },
} as const;
