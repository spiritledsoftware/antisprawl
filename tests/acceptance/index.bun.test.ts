import * as BunServices from "@effect/platform-bun/BunServices";
import { test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  verifyEmbeddingFailures,
  verifyExplicitIndexFailure,
  verifySemanticCheck,
  verifySemanticInterruption,
  verifyStructuralCheck,
  verifyStructuralCheckLifecycle,
  verifyStructuralIndex,
  type CommandRunner,
} from "./structural-index.harness.ts";

const sourceEntrypoint = Bun.fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const sourceCommandPrefix = ["bun", sourceEntrypoint];

const runCommand: CommandRunner = (projectRoot, arguments_, environment = {}) => {
  const process = Bun.spawnSync(["bun", sourceEntrypoint, ...arguments_], {
    cwd: projectRoot,
    env: { ...Bun.env, NO_COLOR: "1", ...environment },
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    exitCode: process.exitCode,
    stderr: process.stderr.toString(),
    stdout: process.stdout.toString(),
  };
};

test("source index builds and reuses the real TypeScript Structural Index", () =>
  Effect.runPromise(
    Effect.scoped(verifyStructuralIndex(runCommand)).pipe(Effect.provide(BunServices.layer)),
  ));

test("source check applies the frozen Structural policy", () =>
  Effect.runPromise(
    Effect.scoped(verifyStructuralCheck(runCommand)).pipe(Effect.provide(BunServices.layer)),
  ));

test(
  "source check applies deterministic Semantic evidence",
  () =>
    Effect.runPromise(
      Effect.scoped(verifySemanticCheck(runCommand)).pipe(Effect.provide(BunServices.layer)),
    ),
  30_000,
);

test(
  "source check handles embedding failures without stale Semantic evidence",
  () =>
    Effect.runPromise(
      Effect.scoped(verifyEmbeddingFailures(runCommand)).pipe(Effect.provide(BunServices.layer)),
    ),
  30_000,
);

test(
  "source semantic index keeps complete batches and resumes after SIGINT",
  () =>
    Effect.runPromise(
      Effect.scoped(verifySemanticInterruption(runCommand, sourceCommandPrefix)).pipe(
        Effect.provide(BunServices.layer),
      ),
    ),
  30_000,
);

test("source explicit semantic index failure keeps complete batches", () =>
  Effect.runPromise(
    Effect.scoped(verifyExplicitIndexFailure(runCommand)).pipe(Effect.provide(BunServices.layer)),
  ));

test(
  "source check preserves current-Edit-batch and Index boundaries",
  () =>
    Effect.runPromise(
      Effect.scoped(verifyStructuralCheckLifecycle(runCommand)).pipe(
        Effect.provide(BunServices.layer),
      ),
    ),
  30_000,
);
