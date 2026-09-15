import * as BunServices from "@effect/platform-bun/BunServices";
import { test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
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

const run = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>,
): Promise<A> => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunServices.layer)));

test("source index builds and reuses the real TypeScript Structural Index", () =>
  run(verifyStructuralIndex(runCommand)));

test("source check applies the frozen Structural policy", () =>
  run(verifyStructuralCheck(runCommand)));

test(
  "source check applies deterministic Semantic evidence",
  () => run(verifySemanticCheck(runCommand)),
  30_000,
);

test(
  "source check handles embedding failures without stale Semantic evidence",
  () => run(verifyEmbeddingFailures(runCommand)),
  30_000,
);

test(
  "source semantic index keeps complete batches and resumes after SIGINT",
  () => run(verifySemanticInterruption(runCommand, sourceCommandPrefix)),
  30_000,
);

test("source explicit semantic index failure keeps complete batches", () =>
  run(verifyExplicitIndexFailure(runCommand)));

test(
  "source check preserves current-Edit-batch and Index boundaries",
  () => run(verifyStructuralCheckLifecycle(runCommand)),
  30_000,
);
