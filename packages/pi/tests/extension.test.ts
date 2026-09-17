import { expect, test } from "bun:test";
import type { ExecResult, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import antisprawlPi from "../src/extension.ts";

const original = [{ type: "text" as const, text: "edited" }];

const location = (path: string, qualifiedName: string, line: number, column: number) => ({
  path,
  qualifiedName,
  range: {
    start: { line, column },
    end: { line, column },
  },
});

const finding = (id: string, edited: string) => ({
  id,
  type: "probable_duplicate",
  language: "typescript",
  edited: location("src/edit.ts", edited, 1, 1),
  candidate: location("src/jobs.ts", "collectReadyJobs", 10, 1),
  structuralEvidence: {
    strictHashEqual: false,
    normalizedHashEqual: true,
    qgramSimilarity: 0.91,
    orderedTokenSimilarity: 0.88,
  },
  semanticEvidence: { cosineSimilarity: 0.99 },
  guidance: "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
});

const checkOutput = (findings: ReturnType<typeof finding>[], diagnostics: object[] = []) => ({
  protocolVersion: 1,
  command: "check",
  findings,
  diagnostics,
});

const execResult = (overrides: Partial<ExecResult> = {}): ExecResult => ({
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
  ...overrides,
});

const editEvent = (
  overrides: {
    isError?: boolean;
    path?: string;
    omitPath?: boolean;
  } = {},
): ToolResultEvent => {
  const event = {
    type: "tool_result" as const,
    toolCallId: "call-1",
    toolName: "edit" as const,
    isError: overrides.isError ?? false,
    input: overrides.omitPath ? {} : { path: overrides.path ?? "src/edit.ts" },
    content: original,
    details: undefined,
  };

  return event;
};

const writeEvent = (): ToolResultEvent => ({
  type: "tool_result",
  toolCallId: "call-1",
  toolName: "write",
  isError: false,
  input: { path: "src/edit.ts" },
  content: original,
  details: undefined,
});

const load = (exec: ExtensionAPI["exec"]) => {
  let sessionStart = () => undefined;

  let onResult: (
    event: ToolResultEvent,
    ctx: { cwd: string; signal: AbortSignal | undefined },
  ) => Promise<{ content?: ToolResultEvent["content"] } | undefined> = async () => undefined;

  const pi = {
    exec,
    on(event: "session_start" | "tool_result", handler: typeof sessionStart | typeof onResult) {
      if (event === "session_start") {
        // SAFETY: session_start is registered with a void handler.
        sessionStart = handler as typeof sessionStart;

        return;
      }

      // SAFETY: tool_result is registered with the result handler.
      onResult = handler as typeof onResult;
    },
  };

  // SAFETY: the fake implements the exec/on subset the extension uses.
  antisprawlPi(pi as ExtensionAPI);

  return {
    sessionStart: () => sessionStart(),
    toolResult: (event: ToolResultEvent, cwd = "/project") =>
      onResult(event, { cwd, signal: undefined }),
  };
};

const appendedText = (
  patch: { content?: ToolResultEvent["content"] } | undefined,
): string | undefined => {
  const last = patch?.content?.at(-1);

  return last?.type === "text" ? last.text : undefined;
};

test("failed edit or write does not invoke antisprawl", async () => {
  const extension = load(async () => {
    throw new Error("pi.exec should not run");
  });

  expect(await extension.toolResult(editEvent({ isError: true }))).toBeUndefined();
  expect(await extension.toolResult({ ...writeEvent(), isError: true })).toBeUndefined();
});

test("successful edit invokes check with the exact path, cwd, signal, and timeout", async () => {
  const calls: Array<{
    command: string;
    args: string[];
    options: { cwd?: string; signal?: AbortSignal; timeout?: number } | undefined;
  }> = [];

  const extension = load(async (command, args, options) => {
    calls.push({ command, args, options });

    return execResult({ stdout: JSON.stringify(checkOutput([])) });
  });

  expect(await extension.toolResult(editEvent())).toBeUndefined();
  expect(calls).toEqual([
    {
      command: "antisprawl",
      args: ["check", "src/edit.ts"],
      options: { cwd: "/project", signal: undefined, timeout: 5000 },
    },
  ]);
});

test("leading @ path syntax is stripped before check", async () => {
  let args: string[] = [];

  const extension = load(async (_command, received) => {
    args = received;

    return execResult({ stdout: JSON.stringify(checkOutput([])) });
  });

  await extension.toolResult(editEvent({ path: "@src/edit.ts" }));
  expect(args).toEqual(["check", "src/edit.ts"]);
});

test("successful write is one Edit batch", async () => {
  let args: string[] = [];

  const extension = load(async (_command, received) => {
    args = received;

    return execResult({ stdout: JSON.stringify(checkOutput([])) });
  });

  await extension.toolResult(writeEvent());
  expect(args).toEqual(["check", "src/edit.ts"]);
});

test("missing path does not invoke antisprawl", async () => {
  const extension = load(async () => {
    throw new Error("pi.exec should not run");
  });

  expect(await extension.toolResult(editEvent({ omitPath: true }))).toBeUndefined();
});

test("zero Findings leave the tool result untouched", async () => {
  const extension = load(async () => execResult({ stdout: JSON.stringify(checkOutput([])) }));

  expect(await extension.toolResult(editEvent())).toBeUndefined();
});

test("a successful check appends at most three Findings and an omitted count", async () => {
  const findings = [
    finding("id-1", "alpha"),
    finding("id-2", "beta"),
    finding("id-3", "gamma"),
    finding("id-4", "delta"),
  ];

  const extension = load(async () => execResult({ stdout: JSON.stringify(checkOutput(findings)) }));
  const patch = await extension.toolResult(editEvent());

  expect(patch?.content?.slice(0, -1)).toEqual(original);
  expect(appendedText(patch)).toBe(
    [
      "id: id-1",
      "Edited: alpha (src/edit.ts:1:1)",
      "Candidate: collectReadyJobs (src/jobs.ts:10:1)",
      "strictHashEqual: false",
      "normalizedHashEqual: true",
      "qgramSimilarity: 0.91",
      "orderedTokenSimilarity: 0.88",
      "cosineSimilarity: 0.99",
      "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
      "id: id-2",
      "Edited: beta (src/edit.ts:1:1)",
      "Candidate: collectReadyJobs (src/jobs.ts:10:1)",
      "strictHashEqual: false",
      "normalizedHashEqual: true",
      "qgramSimilarity: 0.91",
      "orderedTokenSimilarity: 0.88",
      "cosineSimilarity: 0.99",
      "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
      "id: id-3",
      "Edited: gamma (src/edit.ts:1:1)",
      "Candidate: collectReadyJobs (src/jobs.ts:10:1)",
      "strictHashEqual: false",
      "normalizedHashEqual: true",
      "qgramSimilarity: 0.91",
      "orderedTokenSimilarity: 0.88",
      "cosineSimilarity: 0.99",
      "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
      "(+1 more Findings)",
    ].join("\n"),
  );
});

test("project_not_found and source_path_unsupported are silent", async () => {
  for (const code of ["project_not_found", "source_path_unsupported"]) {
    const extension = load(async () => execResult({ code: 1, stderr: `error[${code}]: nope` }));

    expect(await extension.toolResult(editEvent()), code).toBeUndefined();
  }
});

test("index_missing and index_incompatible ask to run antisprawl index once", async () => {
  let stderr = "error[index_missing]: No Index exists.";
  const extension = load(async () => execResult({ code: 1, stderr }));

  expect(appendedText(await extension.toolResult(editEvent()))).toBe("Run antisprawl index.");
  stderr = "error[index_incompatible]: The existing Index schema is incompatible.";
  expect(appendedText(await extension.toolResult(editEvent()))).toBeUndefined();
});

test("missing antisprawl on PATH is reported once", async () => {
  const extension = load(async () => execResult({ code: 1 }));

  expect(appendedText(await extension.toolResult(editEvent()))).toBe("antisprawl is not on PATH.");
  expect(appendedText(await extension.toolResult(editEvent()))).toBeUndefined();
});

test("invalid configuration is reported once", async () => {
  const extension = load(async () => execResult({ code: 1, stderr: "error[config_invalid]: bad" }));

  expect(appendedText(await extension.toolResult(editEvent()))).toBe(
    "Antisprawl configuration is invalid.",
  );
  expect(appendedText(await extension.toolResult(editEvent()))).toBeUndefined();
});

test("malformed or incompatible check output asks for a compatible update once", async () => {
  const extension = load(async () => execResult({ stdout: "{" }));

  expect(appendedText(await extension.toolResult(editEvent()))).toBe(
    "Update antisprawl and @antisprawl/pi to compatible versions.",
  );
  expect(appendedText(await extension.toolResult(editEvent()))).toBeUndefined();
});

test("a broken Finding makes the payload incompatible", async () => {
  const extension = load(async () =>
    execResult({
      stdout: JSON.stringify({
        protocolVersion: 1,
        command: "check",
        findings: [{ id: "x" }],
        diagnostics: [],
      }),
    }),
  );

  expect(appendedText(await extension.toolResult(editEvent()))).toBe(
    "Update antisprawl and @antisprawl/pi to compatible versions.",
  );
});

test("timeout and unexpected failures stay silent", async () => {
  const killed = load(async () => execResult({ killed: true, code: 1 }));

  const unexpected = load(async () =>
    execResult({ code: 1, stderr: "error: The command failed." }),
  );

  expect(await killed.toolResult(editEvent())).toBeUndefined();
  expect(await unexpected.toolResult(editEvent())).toBeUndefined();
});

test("successful diagnostics are injected once per code", async () => {
  const extension = load(async () =>
    execResult({
      stdout: JSON.stringify(
        checkOutput([], [{ code: "vector_search_fallback", path: "src/edit.ts" }]),
      ),
    }),
  );

  expect(appendedText(await extension.toolResult(editEvent()))).toBe(
    "vector_search_fallback src/edit.ts",
  );
  expect(appendedText(await extension.toolResult(editEvent()))).toBeUndefined();
});

test("session_start resets diagnostic deduplication", async () => {
  const extension = load(async () => execResult({ code: 1 }));

  expect(appendedText(await extension.toolResult(editEvent()))).toBe("antisprawl is not on PATH.");
  extension.sessionStart();
  expect(appendedText(await extension.toolResult(editEvent()))).toBe("antisprawl is not on PATH.");
});

test("Finding ids are not suppressed after later edits", async () => {
  const extension = load(async () =>
    execResult({ stdout: JSON.stringify(checkOutput([finding("same", "alpha")])) }),
  );

  expect(appendedText(await extension.toolResult(editEvent()))).toContain("id: same");
  expect(appendedText(await extension.toolResult(editEvent()))).toContain("id: same");
});

test("parallel edit checks are not serialized", async () => {
  let started = 0;
  const waiters: Array<() => void> = [];

  const extension = load(async () => {
    started += 1;
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
    });

    return execResult({ stdout: JSON.stringify(checkOutput([])) });
  });

  const first = extension.toolResult(editEvent());
  const second = extension.toolResult(editEvent());

  await Promise.resolve();
  expect(started).toBe(2);

  for (const release of waiters) release();
  await Promise.all([first, second]);
});
