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
} as const;
