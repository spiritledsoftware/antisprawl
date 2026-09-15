import * as BunServices from "@effect/platform-bun/BunServices";
import { test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  verifyStructuralCheck,
  verifyStructuralCheckLifecycle,
  verifyStructuralIndex,
  type CommandRunner,
} from "./structural-index.harness.ts";

const sourceEntrypoint = Bun.fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const runCommand: CommandRunner = (projectRoot, arguments_) => {
  const process = Bun.spawnSync(["bun", sourceEntrypoint, ...arguments_], {
    cwd: projectRoot,
    env: { ...Bun.env, NO_COLOR: "1" },
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
  "source check preserves current-Edit-batch and Index boundaries",
  () =>
    Effect.runPromise(
      Effect.scoped(verifyStructuralCheckLifecycle(runCommand)).pipe(
        Effect.provide(BunServices.layer),
      ),
    ),
  30_000,
);
