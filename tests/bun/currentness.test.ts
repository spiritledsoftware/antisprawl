import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Parser } from "web-tree-sitter";
import { checkProject, indexProject } from "../../src/app.ts";
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

        const parse = spyOn(Parser.prototype, "parse");
        const originalParse = parse.getMockImplementation();

        if (originalParse === undefined) throw new Error("Parser.parse is unavailable.");

        parse.mockImplementation(function (this: Parser, callback, oldTree, options) {
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
          const error = yield* Effect.flip(indexProject(root));

          expect(error).toMatchObject({ code: "source_changed_during_index" });
          expect(yield* fs.readFile(indexPath)).toEqual(before);
        }).pipe(Effect.ensuring(Effect.sync(() => parse.mockRestore())));

        const output = yield* indexProject(root);

        expect(output.work).toEqual({
          files: { indexed: 1, reused: 0, removed: 0 },
          symbols: { indexed: 1, reused: 0, removed: 1 },
          vectors: { indexed: 0, reused: 0, removed: 0 },
        });
      }),
    ),
  ));

test("check marks a file stale when it changes during analysis and retries it", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-currentness-" });
        const sourcePath = paths.join(root, "src/edit.ts");
        const indexPath = paths.join(root, ".antisprawl/index.sqlite");

        yield* writeScenario(root);
        yield* indexProject(root);
        yield* fs.writeFileString(
          sourcePath,
          "export function beforeParse(values: number[]) { return values.filter((value) => value > 0); }\n",
        );

        const parse = spyOn(Parser.prototype, "parse");
        const originalParse = parse.getMockImplementation();

        if (originalParse === undefined) throw new Error("Parser.parse is unavailable.");

        parse.mockImplementation(function (this: Parser, callback, oldTree, options) {
          const write = Bun.spawnSync([
            process.execPath,
            "-e",
            "await Bun.write(process.argv[1], process.argv[2])",
            sourcePath,
            "export function duringParse(values: number[]) { return values.map((value) => value * 2); }\n",
          ]);

          if (write.exitCode !== 0) throw new Error(write.stderr.toString());

          return originalParse.call(this, callback, oldTree, options);
        });

        const stale = yield* checkProject(root, ["src/edit.ts"]).pipe(
          Effect.ensuring(Effect.sync(() => parse.mockRestore())),
        );

        expect(stale.coverage).toEqual({
          status: "degraded",
          files: { total: 2, current: 1, failed: 1 },
        });
        expect(stale.findings).toEqual([]);
        expect(stale.diagnostics).toContainEqual({
          severity: "warning",
          code: "source_changed_during_check",
          path: "src/edit.ts",
        });

        const staleIndex = new Database(indexPath, { readonly: true });

        expect(
          staleIndex.query("select parse_status from files where path = ?").get("src/edit.ts"),
        ).toEqual({
          parse_status: "stale",
        });
        expect(
          staleIndex
            .query("select count(*) as count from symbols where file_path = ?")
            .get("src/edit.ts"),
        ).toEqual({ count: 0 });
        staleIndex.close();

        const retried = yield* checkProject(root, ["src/edit.ts"]);

        expect(retried.coverage.status).toBe("complete");
        expect(retried.work.files.indexed).toBe(1);
      }),
    ),
  ));

test("an unreadable requested source leaves the Index unchanged", () =>
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
        const unreadable = yield* Effect.flip(fs.readFileString(paths.join(root, "missing")));

        const error = yield* Effect.flip(
          checkProject(root, ["src/jobs.ts"]).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFileString: (path, options) =>
                path === sourcePath ? Effect.fail(unreadable) : fs.readFileString(path, options),
            }),
          ),
        );

        expect(error).toMatchObject({ code: "source_unreadable" });
        expect(yield* fs.readFile(indexPath)).toEqual(before);
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
            files: { indexed: 0, reused: 1, removed: 0 },
            symbols: { indexed: 0, reused: 1, removed: 0 },
            vectors: { indexed: 0, reused: 0, removed: 0 },
          });
        }).pipe(Effect.ensuring(Effect.sync(() => parse.mockRestore())));
      }),
    ),
  ));
