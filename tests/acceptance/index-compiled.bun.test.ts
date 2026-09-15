import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyStructuralIndex } from "./structural-index.harness.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const compiledTest = process.platform === "linux" && process.arch === "x64" ? test : test.skip;

compiledTest(
  "Linux x64 executable builds and reuses the real TypeScript Structural Index",
  async () => {
    const buildRoot = await mkdtemp(join(tmpdir(), "antisprawl-compiled-"));
    const executable = join(buildRoot, "antisprawl");

    try {
      const build = Bun.spawnSync(
        [
          "bun",
          "build",
          "--compile",
          "--target=bun-linux-x64",
          join(repositoryRoot, "src/main.ts"),
          "--outfile",
          executable,
        ],
        {
          cwd: repositoryRoot,
          stderr: "pipe",
          stdout: "pipe",
        },
      );

      expect({ exitCode: build.exitCode, stderr: build.stderr.toString() }).toEqual({
        exitCode: 0,
        stderr: "",
      });

      await verifyStructuralIndex((projectRoot) => {
        const process = Bun.spawnSync([executable, "index"], {
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
      });
    } finally {
      await rm(buildRoot, { force: true, recursive: true });
    }
  },
);
