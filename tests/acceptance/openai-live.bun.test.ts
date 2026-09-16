import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { verifyLiveOpenAIProfile, type CommandRunner } from "./structural-index.harness.ts";

const repositoryRoot = Bun.fileURLToPath(new URL("../..", import.meta.url));

const sourceEntrypoint = Bun.fileURLToPath(new URL("../../src/main.ts", import.meta.url));

const liveTest =
  Bun.env.ANTISPRAW_LIVE_OPENAI === "1" && process.platform === "linux" && process.arch === "x64"
    ? test
    : test.skip;

liveTest(
  "Linux x64 executable selects live OpenAI Profiles",
  () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const selectedProvider = Bun.env.ANTISPRAW_LIVE_OPENAI_PROVIDER;

          const providers: ReadonlyArray<"openai" | "openai-codex"> =
            selectedProvider === "openai" || selectedProvider === "openai-codex"
              ? [selectedProvider]
              : ["openai", "openai-codex"];

          if (
            providers.includes("openai") &&
            (Bun.env.OPENAI_API_KEY === undefined || Bun.env.OPENAI_API_KEY === "")
          ) {
            throw new Error("OPENAI_API_KEY is required for live OpenAI acceptance.");
          }

          const fs = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;

          const buildRoot = yield* fs.makeTempDirectoryScoped({
            prefix: "antisprawl-openai-live-",
          });

          const executable = paths.join(buildRoot, "antisprawl");

          const build = Bun.spawnSync(
            [
              "bun",
              "build",
              "--compile",
              "--target=bun-linux-x64",
              "--define",
              "globalThis.ANTISPRAW_LIVE_PROFILE_MATRIX=true",
              sourceEntrypoint,
              "--outfile",
              executable,
            ],
            { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
          );

          expect({ exitCode: build.exitCode, stderr: build.stderr.toString() }).toEqual({
            exitCode: 0,
            stderr: "",
          });

          const runCommand: CommandRunner = (projectRoot, arguments_, environment = {}) => {
            const process = Bun.spawnSync([executable, ...arguments_], {
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

          for (const provider of providers) {
            const evidence: Array<string> = [];
            let selected: 384 | 1536 | undefined;

            for (const dimensions of [384, 1536] as const) {
              const failures = yield* verifyLiveOpenAIProfile(runCommand, provider, dimensions);

              evidence.push(
                `${dimensions}: ${failures.length === 0 ? "passed" : failures.join(", ")}`,
              );

              if (failures.length === 0) selected ??= dimensions;
            }

            expect(selected, `${provider}: ${evidence.join("; ")}`).toBe(384);
          }
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    ),
  10 * 60_000,
);
