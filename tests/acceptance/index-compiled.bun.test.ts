import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  verifyStructuralCheck,
  verifyStructuralCheckLifecycle,
  verifyStructuralIndex,
  type CommandRunner,
} from "./structural-index.harness.ts";

const repositoryRoot = Bun.fileURLToPath(new URL("../..", import.meta.url));

const sourceEntrypoint = Bun.fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const compiledTest = process.platform === "linux" && process.arch === "x64" ? test : test.skip;

compiledTest(
  "Linux x64 executable builds and runs Structural-only check",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const buildRoot = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-compiled-" });
          const executable = paths.join(buildRoot, "antisprawl");

          const build = Bun.spawnSync(
            [
              "bun",
              "build",
              "--compile",
              "--target=bun-linux-x64",
              sourceEntrypoint,
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

          const runCommand: CommandRunner = (projectRoot, arguments_) => {
            const process = Bun.spawnSync([executable, ...arguments_], {
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

          yield* verifyStructuralIndex(runCommand);
          yield* verifyStructuralCheck(runCommand);
          yield* verifyStructuralCheckLifecycle(runCommand);
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ),
  60_000,
);
