import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { structuralCheckScenario } from "./structural-check.scenario.ts";
import { structuralIndexScenario } from "./structural-index.scenario.ts";

const Json = Schema.fromJsonString(Schema.Unknown);

const CheckOutput = Schema.fromJsonString(
  Schema.Struct({
    coverage: Schema.Struct({
      status: Schema.String,
      files: Schema.Struct({ total: Schema.Int, current: Schema.Int, failed: Schema.Int }),
    }),
    work: Schema.Struct({
      files: Schema.Struct({ indexed: Schema.Int, reused: Schema.Int, removed: Schema.Int }),
      symbols: Schema.Struct({ indexed: Schema.Int, reused: Schema.Int, removed: Schema.Int }),
      vectors: Schema.Struct({ indexed: Schema.Int, reused: Schema.Int, removed: Schema.Int }),
    }),
    diagnostics: Schema.Array(
      Schema.Struct({
        severity: Schema.String,
        code: Schema.String,
        path: Schema.optionalKey(Schema.String),
      }),
    ),
    findings: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        edited: Schema.Struct({ path: Schema.String, qualifiedName: Schema.String }),
        candidate: Schema.Struct({ path: Schema.String, qualifiedName: Schema.String }),
      }),
    ),
  }),
);

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export type CommandRunner = (
  projectRoot: string,
  arguments_: ReadonlyArray<string>,
  environment?: Readonly<Record<string, string>>,
) => CommandResult;

export type CommandPrefix = ReadonlyArray<string>;

const createProject = Effect.fn("Acceptance.createProject")(function* (
  prefix: string,
  files: Readonly<Record<string, string>>,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix });

  for (const [path, contents] of Object.entries(files)) {
    const absolutePath = paths.join(root, path);

    yield* fs.makeDirectory(paths.dirname(absolutePath), { recursive: true });
    yield* fs.writeFileString(absolutePath, contents);
  }

  return root;
});

const checkOutput = (
  runCommand: CommandRunner,
  projectRoot: string,
  ...paths: ReadonlyArray<string>
) => {
  const result = runCommand(projectRoot, ["check", ...paths]);

  if (result.stdout === "") throw new Error(result.stderr);

  return Schema.decodeEffect(CheckOutput)(result.stdout);
};

export const verifyStructuralIndex = Effect.fn("Acceptance.verifyStructuralIndex")(function* (
  runCommand: CommandRunner,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const projectRoot = yield* createProject("antisprawl-index-", {
    [structuralIndexScenario.configPath]: structuralIndexScenario.config,
    ...structuralIndexScenario.files,
  });

  const first = runCommand(projectRoot, ["index"]);

  expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });

  const firstOutput = yield* Schema.decodeEffect(Json)(first.stdout);

  expect(firstOutput).toEqual(structuralIndexScenario.firstOutput);

  const indexPath = paths.join(projectRoot, ".antisprawl/index.sqlite");
  const index = new Database(indexPath, { readonly: true });

  expect(index.query("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(index.query("select key, value from metadata order by key").all()).toEqual(
    structuralIndexScenario.index.metadata,
  );
  expect(index.query("select * from files order by path").all()).toEqual(
    structuralIndexScenario.index.files,
  );
  expect(
    index
      .query(`
          select
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
            typeof(ordered_token_hashes) as ordered_type,
            length(ordered_token_hashes) as ordered_bytes,
            typeof(qgram_hashes) as qgram_type,
            length(qgram_hashes) as qgram_bytes,
            embedding_hash
          from symbols
          order by file_path, symbol_key
        `)
      .all(),
  ).toEqual(structuralIndexScenario.index.symbols);
  index.close();

  const databaseText = new TextDecoder().decode(yield* fs.readFile(indexPath));

  for (const sourceToken of ["cancelledAt", "ready", "queued"]) {
    expect(databaseText).not.toContain(sourceToken);
  }

  const second = runCommand(projectRoot, ["index"]);

  expect({ exitCode: second.exitCode, stderr: second.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  expect(yield* Schema.decodeEffect(Json)(second.stdout)).toEqual({
    ...structuralIndexScenario.firstOutput,
    work: {
      files: { indexed: 0, reused: 1, removed: 0 },
      symbols: { indexed: 0, reused: 1, removed: 0 },
      vectors: { indexed: 0, reused: 0, removed: 0 },
    },
  });
});

export const verifyStructuralCheck = Effect.fn("Acceptance.verifyStructuralCheck")(function* (
  runCommand: CommandRunner,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  for (const edit of structuralCheckScenario.edits) {
    const projectRoot = yield* createProject("antisprawl-check-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
    });

    expect(runCommand(projectRoot, ["index"]).exitCode, edit.name).toBe(0);
    yield* fs.writeFileString(paths.join(projectRoot, "src/edit.ts"), edit.source);

    const checked = runCommand(projectRoot, ["check", "src/edit.ts"]);

    expect({ exitCode: checked.exitCode, stderr: checked.stderr }, edit.name).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const output = yield* Schema.decodeEffect(Json)(checked.stdout);

    expect(output, edit.name).toMatchObject({
      protocolVersion: 1,
      command: "check",
      coverage: {
        status: "complete",
        files: { total: 2, current: 2, failed: 0 },
      },
      work: {
        files: { indexed: 1, reused: 1, removed: 0 },
        symbols: { indexed: 1, reused: 1, removed: 0 },
      },
      findings:
        edit.finding === undefined
          ? []
          : [
              {
                type: "probable_duplicate",
                language: "typescript",
                edited: {
                  path: "src/edit.ts",
                  qualifiedName: edit.finding.edited,
                  range: {
                    start: { line: 3, column: 8 },
                    end: { line: edit.finding.endLine, column: 2 },
                  },
                },
                candidate: {
                  path: "src/jobs.ts",
                  qualifiedName: "collectReadyJobs",
                  range: {
                    start: { line: 8, column: 8 },
                    end: { line: 16, column: 2 },
                  },
                },
                structuralEvidence: {
                  strictHashEqual: false,
                  normalizedHashEqual: edit.finding.qgramSimilarity === 1,
                  qgramSimilarity: edit.finding.qgramSimilarity,
                  orderedTokenSimilarity: edit.finding.orderedTokenSimilarity,
                },
                guidance:
                  "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
              },
            ],
    });
  }
});

export const verifySemanticCheck = Effect.fn("Acceptance.verifySemanticCheck")(function* (
  runCommand: CommandRunner,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const projectRoot = yield* createProject("antisprawl-semantic-check-", {
    [structuralCheckScenario.configPath]: structuralCheckScenario.config,
    ...structuralCheckScenario.baseline,
  });

  const environment = {
    ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
    XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
  };

  const indexed = runCommand(projectRoot, ["index"], environment);

  expect({ exitCode: indexed.exitCode, stderr: indexed.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  expect(yield* Schema.decodeEffect(Json)(indexed.stdout)).toMatchObject({
    protocolVersion: 1,
    command: "index",
    analysis: { mode: "semantic", vectorSearch: "sqlite_vec" },
    coverage: { status: "complete" },
    work: { vectors: { indexed: 1, reused: 0, removed: 0 } },
    provenance: {
      profile: {
        provider: "deterministic",
        model: "acceptance-v1",
        dimensions: 2,
        language: "typescript",
        embeddingRepresentation: 1,
        detector: 2,
        semanticThreshold: 0.85,
        calibration: "calibrated",
      },
    },
  });

  const index = new Database(paths.join(projectRoot, ".antisprawl/index.sqlite"), {
    readonly: true,
  });

  expect(
    index
      .query(
        "select dimensions, typeof(vector) as vector_type, length(vector) as vector_bytes from vectors",
      )
      .all(),
  ).toEqual([{ dimensions: 2, vector_type: "blob", vector_bytes: 8 }]);
  index.close();

  const indexText = new TextDecoder().decode(
    yield* fs.readFile(paths.join(projectRoot, ".antisprawl/index.sqlite")),
  );

  for (const forbidden of ["cancelledAt", "ready.push", "typescript\\nexport"]) {
    expect(indexText).not.toContain(forbidden);
  }

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy,
  );

  const checked = runCommand(projectRoot, ["check", "src/edit.ts"], environment);

  expect({ exitCode: checked.exitCode, stderr: checked.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const checkedOutput = yield* Schema.decodeEffect(Json)(checked.stdout);
  const checkedCore = yield* Schema.decodeEffect(CheckOutput)(checked.stdout);

  expect(checkedOutput).toMatchObject({
    protocolVersion: 1,
    command: "check",
    analysis: { mode: "semantic", vectorSearch: "sqlite_vec" },
    coverage: { status: "complete" },
    work: { vectors: { indexed: 1, reused: 1, removed: 0 } },
    findings: [
      {
        type: "probable_duplicate",
        edited: { path: "src/edit.ts", qualifiedName: "listEligibleJobs" },
        candidate: { path: "src/jobs.ts", qualifiedName: "collectReadyJobs" },
        semanticEvidence: { cosineSimilarity: 1 },
      },
    ],
  });

  for (const forbidden of ["cancelledAt", '"vector"', '"embeddingInput"']) {
    expect(checked.stdout).not.toContain(forbidden);
  }

  for (const failure of ["digest", "extract", "load", "probe"] as const) {
    const fallbackRoot = yield* createProject("antisprawl-semantic-fallback-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
    });

    const fallbackEnvironment = {
      ...environment,
      XDG_CACHE_HOME: paths.join(fallbackRoot, ".cache"),
    };

    expect(runCommand(fallbackRoot, ["index"], fallbackEnvironment).exitCode, failure).toBe(0);
    yield* fs.writeFileString(
      paths.join(fallbackRoot, "src/edit.ts"),
      structuralCheckScenario.renamedCopy,
    );

    const fallback = runCommand(fallbackRoot, ["check", "src/edit.ts"], {
      ...fallbackEnvironment,
      ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE: failure,
    });

    const fallbackOutput = yield* Schema.decodeEffect(Json)(fallback.stdout);
    const fallbackCore = yield* Schema.decodeEffect(CheckOutput)(fallback.stdout);

    expect(fallback.exitCode, failure).toBe(0);
    expect(fallback.stderr, failure).toBe("warning[vector_search_fallback]\n");
    expect(fallbackOutput, failure).toMatchObject({
      analysis: { mode: "semantic", vectorSearch: "application_exact" },
      coverage: { status: "complete" },
      diagnostics: [{ severity: "warning", code: "vector_search_fallback" }],
      findings: [{ semanticEvidence: { cosineSimilarity: 1 } }],
    });
    expect(fallbackCore.findings[0]?.id, failure).toBe(checkedCore.findings[0]?.id);
  }

  for (const edit of structuralCheckScenario.edits.slice(1)) {
    const isolatedRoot = yield* createProject("antisprawl-semantic-case-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
    });

    const isolatedEnvironment = {
      ...environment,
      XDG_CACHE_HOME: paths.join(isolatedRoot, ".cache"),
    };

    expect(runCommand(isolatedRoot, ["index"], isolatedEnvironment).exitCode, edit.name).toBe(0);
    yield* fs.writeFileString(paths.join(isolatedRoot, "src/edit.ts"), edit.source);

    const result = runCommand(isolatedRoot, ["check", "src/edit.ts"], isolatedEnvironment);
    const output = yield* Schema.decodeEffect(Json)(result.stdout);
    const core = yield* Schema.decodeEffect(CheckOutput)(result.stdout);

    expect({ exitCode: result.exitCode, stderr: result.stderr }, edit.name).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(output, edit.name).toMatchObject({
      analysis: { mode: "semantic", vectorSearch: "sqlite_vec" },
      coverage: { status: "complete" },
      findings:
        edit.finding === undefined
          ? []
          : [
              {
                edited: { qualifiedName: edit.finding.edited },
                candidate: { qualifiedName: "collectReadyJobs" },
                semanticEvidence: { cosineSimilarity: 1 },
              },
            ],
    });

    const fallbackRoot = yield* createProject("antisprawl-semantic-case-fallback-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
    });

    const fallbackEnvironment = {
      ...environment,
      XDG_CACHE_HOME: paths.join(fallbackRoot, ".cache"),
    };

    expect(runCommand(fallbackRoot, ["index"], fallbackEnvironment).exitCode, edit.name).toBe(0);
    yield* fs.writeFileString(paths.join(fallbackRoot, "src/edit.ts"), edit.source);

    const fallback = runCommand(fallbackRoot, ["check", "src/edit.ts"], {
      ...fallbackEnvironment,
      ANTISPRAW_ACCEPTANCE_VECTOR_SEARCH_FAILURE: "probe",
    });

    const fallbackOutput = yield* Schema.decodeEffect(Json)(fallback.stdout);
    const fallbackCore = yield* Schema.decodeEffect(CheckOutput)(fallback.stdout);

    expect({ exitCode: fallback.exitCode, stderr: fallback.stderr }, edit.name).toEqual({
      exitCode: 0,
      stderr: "warning[vector_search_fallback]\n",
    });
    expect(fallbackOutput, edit.name).toMatchObject({
      analysis: { mode: "semantic", vectorSearch: "application_exact" },
    });
    expect(fallbackCore.coverage, edit.name).toEqual(core.coverage);
    expect(fallbackCore.findings, edit.name).toEqual(core.findings);
  }

  const identityRoot = yield* createProject("antisprawl-semantic-identity-", {
    [structuralCheckScenario.configPath]: structuralCheckScenario.config,
    ...structuralCheckScenario.baseline,
  });

  const identityTrace = paths.join(identityRoot, "identity.trace");

  const identityEnvironment = {
    ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
    XDG_CACHE_HOME: paths.join(identityRoot, ".cache"),
  };

  expect(runCommand(identityRoot, ["index"], identityEnvironment).exitCode).toBe(0);

  const reconciled = runCommand(identityRoot, ["check"], {
    ...identityEnvironment,
    ANTISPRAW_ACCEPTANCE_EMBEDDING_MODEL: "acceptance-v2",
    ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE: identityTrace,
  });

  const reconciledOutput = yield* Schema.decodeEffect(Json)(reconciled.stdout);

  expect({ exitCode: reconciled.exitCode, stderr: reconciled.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  expect((yield* fs.readFileString(identityTrace)).trim().split("\n")).toHaveLength(2);
  expect(reconciledOutput).toMatchObject({
    analysis: { mode: "semantic", vectorSearch: "sqlite_vec" },
    coverage: { status: "complete" },
    work: { vectors: { indexed: 1, reused: 0, removed: 1 } },
    provenance: { profile: { model: "acceptance-v2" } },
  });
});

export const verifyEmbeddingFailures = Effect.fn("Acceptance.verifyEmbeddingFailures")(function* (
  runCommand: CommandRunner,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const failures = [
    ["auth", "embedding_authentication_failed"],
    ["transport", "embedding_transport_failed"],
    ["wrong_count", "embedding_response_count_invalid"],
    ["wrong_order", "embedding_response_order_invalid"],
    ["wrong_index", "embedding_response_order_invalid"],
    ["nonfinite", "embedding_vector_non_finite"],
    ["dimensions", "embedding_vector_dimensions_invalid"],
    ["zero", "embedding_vector_zero"],
    ["timeout", "embedding_timeout"],
  ] as const;

  for (const [failure, code] of failures) {
    const projectRoot = yield* createProject("antisprawl-embedding-failure-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
    });

    const environment = {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_FAILURE: failure,
      ANTISPRAW_ACCEPTANCE_EMBEDDING_DEADLINE_MS: "10",
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    };

    const healthyEnvironment = {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    };

    expect(runCommand(projectRoot, ["index"], healthyEnvironment).exitCode, failure).toBe(0);
    yield* fs.writeFileString(
      paths.join(projectRoot, "src/edit.ts"),
      structuralCheckScenario.sameFilePair,
    );

    const checked = runCommand(projectRoot, ["check", "src/edit.ts"], environment);
    const output = yield* Schema.decodeEffect(Json)(checked.stdout);

    expect(checked.exitCode, failure).toBe(0);
    expect(checked.stderr, failure).toBe(`warning[${code}]\n`);
    expect(output, failure).toMatchObject({
      analysis: { mode: "structural_only" },
      coverage: { status: "partial" },
      diagnostics: [{ severity: "warning", code }],
      findings: [{ type: "probable_duplicate" }],
    });
    expect(checked.stdout, failure).not.toContain("semanticEvidence");

    const index = new Database(paths.join(projectRoot, ".antisprawl/index.sqlite"), {
      readonly: true,
    });

    expect(index.query("select count(*) as count from vectors").get(), failure).toEqual({
      count: 1,
    });
    index.close();
  }
});

export const verifySemanticInterruption = Effect.fn("Acceptance.verifySemanticInterruption")(
  function* (runCommand: CommandRunner, commandPrefix: CommandPrefix) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const files = {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
      "src/math.ts": structuralCheckScenario.sameFilePair,
    };

    const projectRoot = yield* createProject("antisprawl-embedding-interrupt-", files);
    const tracePath = paths.join(projectRoot, "batch.trace");

    const environment = {
      ...Bun.env,
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE: tracePath,
      ANTISPRAW_ACCEPTANCE_PAUSE_AFTER_BATCH: "1",
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    };

    const child = Bun.spawn([...commandPrefix, "index"], {
      cwd: projectRoot,
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });

    let committed = false;

    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (yield* fs.exists(tracePath)) {
        committed = true;
        break;
      }

      yield* Effect.sleep(10);
    }

    expect(committed).toBe(true);
    child.kill("SIGINT");

    const exitCode = yield* Effect.promise(() => child.exited);
    const stdout = yield* Effect.promise(() => new Response(child.stdout).text());

    expect(exitCode).toBe(130);
    expect(stdout).toBe("");

    const indexPath = paths.join(projectRoot, ".antisprawl/index.sqlite");
    const partial = new Database(indexPath, { readonly: true });

    expect(partial.query("select complete from profile").get()).toEqual({ complete: 0 });
    expect(partial.query("select count(*) as count from vectors").get()).toEqual({ count: 2 });
    partial.close();

    const resumed = runCommand(projectRoot, ["index"], {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE: tracePath,
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    });

    const resumedOutput = yield* Schema.decodeEffect(Json)(resumed.stdout);

    expect(resumed.exitCode).toBe(0);
    expect((yield* fs.readFileString(tracePath)).trim().split("\n")).toHaveLength(2);
    expect(resumedOutput).toMatchObject({
      coverage: { status: "complete" },
      work: { vectors: { indexed: 1, reused: 2, removed: 0 } },
    });

    const cleanRoot = yield* createProject("antisprawl-embedding-clean-", files);

    const clean = runCommand(cleanRoot, ["index"], {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      XDG_CACHE_HOME: paths.join(cleanRoot, ".cache"),
    });

    expect(clean.exitCode).toBe(0);

    const completed = new Database(indexPath, { readonly: true });

    const cleanIndex = new Database(paths.join(cleanRoot, ".antisprawl/index.sqlite"), {
      readonly: true,
    });

    const stateQuery = `
    select embedding_identity, input_hash, dimensions, hex(vector) as vector
    from vectors order by embedding_identity, input_hash
  `;

    const profileQuery = `
    select provider, model, dimensions, language, embedding_representation,
      detector_version, semantic_threshold, calibration_state, complete,
      usage_requests, usage_inputs, usage_input_tokens, usage_duration_ms
    from profile
  `;

    expect(completed.query(stateQuery).all()).toEqual(cleanIndex.query(stateQuery).all());
    expect(completed.query(profileQuery).all()).toEqual(cleanIndex.query(profileQuery).all());
    completed.close();
    cleanIndex.close();
  },
);

export const verifyExplicitIndexFailure = Effect.fn("Acceptance.verifyExplicitIndexFailure")(
  function* (runCommand: CommandRunner) {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    const projectRoot = yield* createProject("antisprawl-embedding-index-failure-", {
      [structuralCheckScenario.configPath]: structuralCheckScenario.config,
      ...structuralCheckScenario.baseline,
      "src/math.ts": structuralCheckScenario.sameFilePair,
    });

    const result = runCommand(projectRoot, ["index"], {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_FAILURE: "transport",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_FAILURE_BATCH: "2",
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error[embedding_transport_failed]");

    const index = new Database(paths.join(projectRoot, ".antisprawl/index.sqlite"), {
      readonly: true,
    });

    expect(index.query("select complete from profile").get()).toEqual({ complete: 0 });
    expect(index.query("select count(*) as count from vectors").get()).toEqual({ count: 2 });
    index.close();

    const tracePath = paths.join(projectRoot, "named-check.trace");

    yield* fs.writeFileString(
      paths.join(projectRoot, "src/edit.ts"),
      structuralCheckScenario.renamedCopy,
    );

    const checked = runCommand(projectRoot, ["check", "src/edit.ts"], {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE: tracePath,
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    });

    const output = yield* Schema.decodeEffect(Json)(checked.stdout);

    expect(checked.exitCode).toBe(0);
    expect(checked.stderr).toBe("warning[semantic_index_partial]\n");
    expect(yield* fs.exists(tracePath)).toBe(false);
    expect(output).toMatchObject({
      analysis: { mode: "structural_only" },
      coverage: { status: "partial" },
      findings: [{ type: "probable_duplicate" }],
    });

    const reconciled = runCommand(projectRoot, ["check"], {
      ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
      ANTISPRAW_ACCEPTANCE_EMBEDDING_TRACE: tracePath,
      XDG_CACHE_HOME: paths.join(projectRoot, ".cache"),
    });

    expect(reconciled.exitCode).toBe(0);
    expect(yield* fs.exists(tracePath)).toBe(true);
    expect((yield* fs.readFileString(tracePath)).trim().split("\n")).toHaveLength(3);
    expect(yield* Schema.decodeEffect(Json)(reconciled.stdout)).toMatchObject({
      analysis: { mode: "semantic", vectorSearch: "sqlite_vec" },
      coverage: { status: "complete" },
    });
  },
);

export const verifyStructuralCheckLifecycle = Effect.fn(
  "Acceptance.verifyStructuralCheckLifecycle",
)(function* (runCommand: CommandRunner) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;

  const freshProject = createProject("antisprawl-check-lifecycle-", {
    [structuralCheckScenario.configPath]: structuralCheckScenario.config,
    ...structuralCheckScenario.baseline,
  });

  const projectRoot = yield* freshProject;

  expect(runCommand(projectRoot, ["index"]).exitCode).toBe(0);
  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy,
  );

  const first = runCommand(projectRoot, ["check", "src/edit.ts"]);
  const firstOutput = yield* Schema.decodeEffect(CheckOutput)(first.stdout);
  const findingId = firstOutput.findings[0]?.id;

  expect(first.exitCode).toBe(0);
  expect(findingId).toMatch(/^[0-9a-f]{64}$/);

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy.replace(
      "  const eligible",
      "  // Formatting and comments do not make this an Edited symbol.\n\n  const eligible",
    ),
  );

  expect((yield* checkOutput(runCommand, projectRoot, "src/edit.ts")).findings).toEqual([]);

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy,
  );
  yield* fs.writeFileString(
    paths.join(projectRoot, "src/jobs.ts"),
    structuralCheckScenario.baseline["src/jobs.ts"]
      .replaceAll("jobs", "items")
      .replaceAll("job", "item")
      .replaceAll("ready", "eligible"),
  );

  const reversed = yield* checkOutput(runCommand, projectRoot, "src/jobs.ts");

  expect(reversed.findings).toHaveLength(1);
  expect(reversed.findings[0]).toMatchObject({
    id: findingId,
    edited: { path: "src/jobs.ts", qualifiedName: "collectReadyJobs" },
    candidate: { path: "src/edit.ts", qualifiedName: "listEligibleJobs" },
  });

  const unchanged = yield* checkOutput(runCommand, projectRoot, "src/jobs.ts");

  expect(unchanged.findings).toEqual([]);
  expect(unchanged.work).toEqual({
    files: { indexed: 0, reused: 2, removed: 0 },
    symbols: { indexed: 0, reused: 2, removed: 0 },
    vectors: { indexed: 0, reused: 0, removed: 0 },
  });

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/unrelated.ts"),
    "export function unrelated(value: number): number { return value + 1; }\n",
  );

  expect((yield* checkOutput(runCommand, projectRoot, "src/unrelated.ts")).findings).toEqual([]);

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.unrelatedSameName,
  );

  expect((yield* checkOutput(runCommand, projectRoot, "src/edit.ts")).findings).toEqual([]);

  yield* fs.writeFileString(
    paths.join(projectRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy,
  );

  const restored = yield* checkOutput(runCommand, projectRoot, "src/edit.ts");

  expect(restored.findings).toHaveLength(1);
  expect(restored.findings[0]?.id).toBe(findingId);

  yield* fs.remove(paths.join(projectRoot, "src/edit.ts"));

  const removed = yield* checkOutput(runCommand, projectRoot, "src/edit.ts");

  expect(removed.findings).toEqual([]);
  expect(removed.work.files.removed).toBe(1);
  expect(removed.work.symbols.removed).toBe(1);

  const namedRoot = yield* freshProject;

  expect(runCommand(namedRoot, ["index"]).exitCode).toBe(0);
  yield* fs.writeFileString(
    paths.join(namedRoot, "src/edit.ts"),
    structuralCheckScenario.renamedCopy,
  );
  yield* fs.writeFileString(
    paths.join(namedRoot, "src/later.ts"),
    "export function later(value: number): number { return value + 1; }\n",
  );

  const namedOnly = yield* checkOutput(runCommand, namedRoot, "src/edit.ts");

  expect(namedOnly.coverage.files.total).toBe(2);

  const reconciled = yield* checkOutput(runCommand, namedRoot);

  expect(reconciled.work.files).toEqual({ indexed: 1, reused: 2, removed: 0 });
  expect(reconciled.findings).toEqual([]);

  yield* fs.writeFileString(
    paths.join(namedRoot, "src/later.ts"),
    "export function later(value: number): number { return value + 2; }\n",
  );

  const reconciledEdit = yield* checkOutput(runCommand, namedRoot);

  expect(reconciledEdit.work.files).toEqual({ indexed: 1, reused: 2, removed: 0 });
  expect(reconciledEdit.findings).toEqual([]);

  yield* fs.remove(paths.join(namedRoot, "src/later.ts"));

  const reconciledRemoval = yield* checkOutput(runCommand, namedRoot);

  expect(reconciledRemoval.work.files.removed).toBe(1);
  expect(reconciledRemoval.findings).toEqual([]);

  const sameFileRoot = yield* freshProject;

  expect(runCommand(sameFileRoot, ["index"]).exitCode).toBe(0);
  yield* fs.writeFileString(
    paths.join(sameFileRoot, "src/same.ts"),
    structuralCheckScenario.sameFilePair,
  );

  const sameFile = yield* checkOutput(runCommand, sameFileRoot, "src/same.ts");

  expect(sameFile.findings).toHaveLength(1);
  expect(sameFile.findings[0]).toMatchObject({
    edited: { path: "src/same.ts", qualifiedName: "addIncluded" },
    candidate: { path: "src/same.ts", qualifiedName: "sumPositive" },
  });

  const degradedRoot = yield* freshProject;

  expect(runCommand(degradedRoot, ["index"]).exitCode).toBe(0);
  yield* fs.writeFileString(
    paths.join(degradedRoot, "src/edit.ts"),
    `${structuralCheckScenario.renamedCopy}\nexport function broken( {\n`,
  );

  const degraded = runCommand(degradedRoot, ["check", "src/edit.ts"]);
  const degradedOutput = yield* Schema.decodeEffect(CheckOutput)(degraded.stdout);

  expect(degraded.exitCode).toBe(0);
  expect(degraded.stderr).toContain("warning[source_parse_degraded]: src/edit.ts");
  expect(degradedOutput.coverage).toEqual({
    status: "degraded",
    files: { total: 2, current: 1, failed: 1 },
  });
  expect(degradedOutput.findings).toHaveLength(1);

  const unchangedDegraded = yield* checkOutput(runCommand, degradedRoot);

  expect(unchangedDegraded.coverage.status).toBe("degraded");
  expect(unchangedDegraded.work.files).toEqual({ indexed: 0, reused: 2, removed: 0 });
  expect(unchangedDegraded.findings).toEqual([]);

  const missingRoot = yield* freshProject;
  const missing = runCommand(missingRoot, ["check"]);

  expect(missing.exitCode).not.toBe(0);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toContain("Run antisprawl index");

  const invalidRoot = yield* freshProject;

  expect(runCommand(invalidRoot, ["index"]).exitCode).toBe(0);

  const indexPath = paths.join(invalidRoot, ".antisprawl/index.sqlite");
  const directoryPath = paths.join(invalidRoot, "src/directory.ts");
  const excludedPath = paths.join(invalidRoot, "src/excluded.ts");
  const outsideRoot = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-outside-" });
  const outsidePath = paths.join(outsideRoot, "outside.ts");

  yield* fs.makeDirectory(directoryPath);
  yield* fs.writeFileString(excludedPath, "export function excluded() {}\n");
  yield* fs.writeFileString(outsidePath, "export function outside() {}\n");

  const before = yield* fs.readFile(indexPath);

  for (const arguments_ of [
    [],
    ["unknown"],
    ["index", "extra"],
    ["check", "--bad"],
    ["check", "src/*.ts"],
    ["check", "src/missing.ts"],
    ["check", "src/jobs.tsx"],
    ["check", "src/directory.ts"],
    ["check", "src/excluded.ts"],
    ["check", outsidePath],
    ["check", ".antisprawl/config.jsonc"],
  ]) {
    const invalid = runCommand(invalidRoot, arguments_);

    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stdout).toBe("");
    expect(yield* fs.readFile(indexPath)).toEqual(before);
  }

  if (process.platform !== "win32") {
    const unreadablePath = paths.join(invalidRoot, "src/unreadable.ts");

    yield* fs.writeFileString(unreadablePath, "export function unreadable() {}\n");
    yield* fs.chmod(unreadablePath, 0);

    const unreadable = runCommand(invalidRoot, ["check", "src/unreadable.ts"]);

    yield* fs.chmod(unreadablePath, 0o600);
    expect(unreadable.exitCode).not.toBe(0);
    expect(unreadable.stdout).toBe("");
    expect(unreadable.stderr).toContain("source_unreadable");
    expect(yield* fs.readFile(indexPath)).toEqual(before);
  }

  yield* fs.writeFileString(
    paths.join(invalidRoot, structuralCheckScenario.configPath),
    structuralCheckScenario.config.replace(
      '  "sources":',
      '  "detection": { "minimumTokens": 1 },\n  "sources":',
    ),
  );

  const unsupportedPolicy = runCommand(invalidRoot, ["check"]);

  expect(unsupportedPolicy.exitCode).not.toBe(0);
  expect(unsupportedPolicy.stdout).toBe("");
  expect(unsupportedPolicy.stderr).toContain("Custom detection settings are not supported");
  expect(yield* fs.readFile(indexPath)).toEqual(before);

  const incompatibleRoot = yield* freshProject;
  const incompatiblePath = paths.join(incompatibleRoot, ".antisprawl/index.sqlite");

  yield* fs.makeDirectory(paths.dirname(incompatiblePath), { recursive: true });

  const incompatibleDatabase = new Database(incompatiblePath);

  incompatibleDatabase.run("PRAGMA user_version = 99");
  incompatibleDatabase.close();

  const incompatibleBefore = yield* fs.readFile(incompatiblePath);
  const incompatible = runCommand(incompatibleRoot, ["check"]);

  expect(incompatible.exitCode).not.toBe(0);
  expect(incompatible.stdout).toBe("");
  expect(yield* fs.readFile(incompatiblePath)).toEqual(incompatibleBefore);
  expect(runCommand(incompatibleRoot, ["index"]).exitCode).toBe(0);

  const replacementDatabase = new Database(incompatiblePath, { readonly: true });

  expect(replacementDatabase.query("PRAGMA user_version").get()).toEqual({ user_version: 3 });
  replacementDatabase.close();

  const corruptRoot = yield* freshProject;
  const corruptPath = paths.join(corruptRoot, ".antisprawl/index.sqlite");

  yield* fs.makeDirectory(paths.dirname(corruptPath), { recursive: true });
  yield* fs.writeFileString(corruptPath, "not a SQLite database");

  const corruptBefore = yield* fs.readFile(corruptPath);

  for (const command of [["check"], ["index"]]) {
    const corrupt = runCommand(corruptRoot, command);

    expect(corrupt.exitCode).not.toBe(0);
    expect(corrupt.stdout).toBe("");
    expect(yield* fs.readFile(corruptPath)).toEqual(corruptBefore);
  }

  const serialized = first.stdout;

  for (const forbidden of ["cancelledAt", '"strictHash":', '"normalizedHash":', "token_hashes"]) {
    expect(serialized).not.toContain(forbidden);
  }
});
