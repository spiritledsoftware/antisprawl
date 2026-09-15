import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { Parser } from "web-tree-sitter";
import { indexProject } from "../../src/app.ts";
import { structuralIndexScenario } from "../acceptance/structural-index.scenario.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const writeScenario = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;

    for (const [path, contents] of Object.entries({
      [structuralIndexScenario.configPath]: structuralIndexScenario.config,
      ...structuralIndexScenario.files,
    })) {
      const absolutePath = paths.join(root, path);

      yield* fs.makeDirectory(paths.dirname(absolutePath), { recursive: true });
      yield* fs.writeFileString(absolutePath, contents);
    }
  });

test("a source change during parsing does not update the Index", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-currentness-" });
        const sourcePath = paths.join(root, "src/jobs.ts");
        const indexPath = paths.join(root, ".antisprawl/index.sqlite");

        yield* writeScenario(root);
        yield* indexProject(root);

        const before = yield* fs.readFile(indexPath);

        yield* fs.writeFileString(sourcePath, "export function beforeParse() { return 1; }\n");

        const parseDescriptor = Object.getOwnPropertyDescriptor(Parser.prototype, "parse");

        if (parseDescriptor?.value === undefined) throw new Error("Parser.parse is unavailable.");

        const originalParse: Parser["parse"] = parseDescriptor.value;

        const parse = spyOn(Parser.prototype, "parse").mockImplementation(function (
          this: Parser,
          callback,
          oldTree,
          options,
        ) {
          const write = Bun.spawnSync([
            process.execPath,
            "-e",
            "await Bun.write(process.argv[1], process.argv[2])",
            sourcePath,
            "export function duringParse() { return 2; }\n",
          ]);

          if (write.exitCode !== 0) throw new Error(write.stderr.toString());

          return originalParse.call(this, callback, oldTree, options);
        });

        yield* Effect.gen(function* () {
          const result = yield* Effect.result(indexProject(root));

          expect(Result.isFailure(result)).toBe(true);

          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({ code: "source_changed_during_index" });
          }

          expect(yield* fs.readFile(indexPath)).toEqual(before);
        }).pipe(Effect.ensuring(Effect.sync(() => parse.mockRestore())));

        const output = yield* indexProject(root);

        expect(output.work).toEqual({
          files: { indexed: 1, reused: 0 },
          symbols: { indexed: 1, reused: 0 },
        });
      }),
    ),
  ));

test("unchanged content hashes skip TypeScript reprocessing", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-currentness-" });

        yield* writeScenario(root);
        yield* indexProject(root);

        const parse = spyOn(Parser.prototype, "parse");

        yield* Effect.gen(function* () {
          const output = yield* indexProject(root);

          expect(parse).not.toHaveBeenCalled();
          expect(output.work).toEqual({
            files: { indexed: 0, reused: 1 },
            symbols: { indexed: 0, reused: 1 },
          });
        }).pipe(Effect.ensuring(Effect.sync(() => parse.mockRestore())));
      }),
    ),
  ));
