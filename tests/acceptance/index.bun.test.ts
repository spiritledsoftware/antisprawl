import * as BunServices from "@effect/platform-bun/BunServices";
import { test } from "bun:test";
import * as Effect from "effect/Effect";
import { verifyStructuralIndex } from "./structural-index.harness.ts";

const sourceEntrypoint = Bun.fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const runIndex = (projectRoot: string) => {
  const process = Bun.spawnSync(["bun", sourceEntrypoint, "index"], {
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
    Effect.scoped(verifyStructuralIndex(runIndex)).pipe(Effect.provide(BunServices.layer)),
  ));
