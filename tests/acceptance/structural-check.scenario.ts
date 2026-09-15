export const structuralCheckScenario = {
  configPath: ".antisprawl/config.jsonc",
  config: `{
  "version": 1,
  "sources": {
    "include": ["src/**/*.ts"],
    "exclude": ["src/excluded.ts"],
  },
}\n`,
  baseline: {
    "src/jobs.ts": `export interface Job {
  readonly id: string;
  readonly status: "ready" | "queued";
  readonly cancelledAt: string | null;
  readonly paused: boolean;
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
  renamedCopy: `import type { Job } from "./jobs.ts";

export function listEligibleJobs(items: ReadonlyArray<Job>): Array<Job> {
  const eligible: Array<Job> = [];
  for (const item of items) {
    if (item.status !== "ready") continue;
    if (item.cancelledAt !== null) continue;
    eligible.push(item);
  }
  return eligible;
}
`,
  unrelatedSameName: `export interface Invoice {
  readonly id: string;
  readonly dueAt: number;
  readonly paidAt: number | null;
}

export function listEligibleJobs(
  invoices: ReadonlyArray<Invoice>,
  now: number,
): Array<Invoice> {
  const overdue: Array<Invoice> = [];
  for (const invoice of invoices) {
    if (invoice.dueAt >= now) continue;
    if (invoice.paidAt !== null) continue;
    overdue.push(invoice);
  }
  return overdue;
}
`,
  sameFilePair: `export function sumPositive(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const value of values) {
    if (value <= 0) continue;
    total += value;
  }
  return total;
}

export function addIncluded(items: ReadonlyArray<number>): number {
  let result = 0;
  for (const item of items) {
    if (item <= 0) continue;
    result += item;
  }
  return result;
}
`,
  edits: [
    {
      name: "renamed copy",
      source: `import type { Job } from "./jobs.ts";

export function listEligibleJobs(items: ReadonlyArray<Job>): Array<Job> {
  const eligible: Array<Job> = [];
  for (const item of items) {
    if (item.status !== "ready") continue;
    if (item.cancelledAt !== null) continue;
    eligible.push(item);
  }
  return eligible;
}
`,
      finding: {
        edited: "listEligibleJobs",
        qgramSimilarity: 1,
        orderedTokenSimilarity: 1,
        endLine: 11,
      },
    },
    {
      name: "added guard",
      source: `import type { Job } from "./jobs.ts";

export function gatherRunnableJobs(jobs: ReadonlyArray<Job>): Array<Job> {
  const runnable: Array<Job> = [];
  for (const job of jobs) {
    if (job.status !== "ready") continue;
    if (job.cancelledAt !== null) continue;
    if (job.paused) continue;
    runnable.push(job);
  }
  return runnable;
}
`,
      finding: {
        edited: "gatherRunnableJobs",
        qgramSimilarity: 0.95082,
        orderedTokenSimilarity: 0.896104,
        endLine: 12,
      },
    },
    {
      name: "structurally similar hard negative",
      source: `export interface Invoice {
  readonly id: string;
  readonly dueAt: number;
  readonly paidAt: number | null;
}

export function collectOverdueInvoices(
  invoices: ReadonlyArray<Invoice>,
  now: number,
): Array<Invoice> {
  const overdue: Array<Invoice> = [];
  for (const invoice of invoices) {
    if (invoice.dueAt >= now) continue;
    if (invoice.paidAt !== null) continue;
    overdue.push(invoice);
  }
  return overdue;
}
`,
      finding: undefined,
    },
    {
      name: "tiny wrapper",
      source: `import type { Job } from "./jobs.ts";

export function isReady(job: Job): boolean {
  return job.status === "ready";
}
`,
      finding: undefined,
    },
  ],
} as const;
