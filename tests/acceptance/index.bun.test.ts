import { test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStructuralIndex } from "./structural-index.harness.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const runIndex = (projectRoot: string) => {
  const process = Bun.spawnSync(["bun", join(repositoryRoot, "src/main.ts"), "index"], {
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
  verifyStructuralIndex(runIndex));
