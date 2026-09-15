import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { discoverSourcePaths, resolveProject, type Project } from "../../src/project.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("the nearest Project uses same-directory config precedence", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const outer = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-project-" });
        const root = paths.join(outer, "nested");
        const child = paths.join(root, "src");

        yield* fs.makeDirectory(paths.join(outer, ".antisprawl"));
        yield* fs.writeFileString(
          paths.join(outer, ".antisprawl/config.jsonc"),
          '{"version":1,"sources":{"include":["outer/**/*.ts"]}}',
        );
        yield* fs.makeDirectory(paths.join(root, ".antisprawl"), { recursive: true });
        yield* fs.makeDirectory(child);
        yield* fs.writeFileString(
          paths.join(root, ".antisprawl/config.jsonc"),
          `{
        // Omitted embedding selects Structural-only mode.
        "version": 1,
        "sources": { "include": ["chosen/**/*.ts"] },
      }`,
        );

        for (const name of [".antisprawl/config.json", ".antisprawl.jsonc", ".antisprawl.json"]) {
          yield* fs.writeFileString(
            paths.join(root, name),
            '{"version":1,"sources":{"include":["ignored/**/*.ts"]}}',
          );
        }

        const project = yield* resolveProject(child);

        expect(project).toMatchObject({
          root,
          configPath: paths.join(root, ".antisprawl/config.jsonc"),
          include: ["chosen/**/*.ts"],
          exclude: [],
          diagnostics: [
            { severity: "warning", code: "config_shadowed", path: ".antisprawl/config.json" },
            { severity: "warning", code: "config_shadowed", path: ".antisprawl.jsonc" },
            { severity: "warning", code: "config_shadowed", path: ".antisprawl.json" },
          ],
        });
      }),
    ),
  ));

test("source discovery includes TypeScript and declaration extensions only", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-project-" });

        for (const path of [
          "source.ts",
          "module.mts",
          "common.cts",
          "types.d.ts",
          "types.d.mts",
          "types.d.cts",
          "deferred.tsx",
          "deferred.js",
          "excluded.ts",
        ]) {
          yield* fs.writeFileString(paths.join(root, path), "export {}\n");
        }

        const project: Project = {
          root,
          configPath: paths.join(root, ".antisprawl/config.jsonc"),
          configHash: "test",
          include: ["*"],
          exclude: ["excluded.ts"],
          diagnostics: [],
        };

        expect(yield* discoverSourcePaths(project)).toEqual([
          "common.cts",
          "module.mts",
          "source.ts",
          "types.d.cts",
          "types.d.mts",
          "types.d.ts",
        ]);
      }),
    ),
  ));

test("source includes cannot escape the Project", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-project-" });
        const root = paths.join(parent, "project");

        yield* fs.makeDirectory(root);
        yield* fs.makeDirectory(paths.join(parent, "outside"));
        yield* fs.writeFileString(
          paths.join(parent, "outside/escaped.ts"),
          "export function escaped() {}\n",
        );

        const project: Project = {
          root,
          configPath: paths.join(root, ".antisprawl/config.jsonc"),
          configHash: "test",
          include: ["../outside/**/*.ts"],
          exclude: [],
          diagnostics: [],
        };

        const error = yield* Effect.flip(discoverSourcePaths(project));

        expect(error).toMatchObject({ code: "source_outside_project" });
      }),
    ),
  ));

test("source symlinks cannot escape the Project", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-project-" });
        const root = paths.join(parent, "project");
        const outside = paths.join(parent, "outside");

        yield* fs.makeDirectory(root);
        yield* fs.makeDirectory(outside);
        yield* fs.writeFileString(
          paths.join(outside, "escaped.ts"),
          "export function escaped() {}\n",
        );
        yield* fs.symlink(outside, paths.join(root, "linked"));

        const project: Project = {
          root,
          configPath: paths.join(root, ".antisprawl/config.jsonc"),
          configHash: "test",
          include: ["linked/**/*.ts"],
          exclude: [],
          diagnostics: [],
        };

        const error = yield* Effect.flip(discoverSourcePaths(project));

        expect(error).toMatchObject({ code: "source_outside_project" });
      }),
    ),
  ));

test("glob adapter paths preserve literal POSIX backslashes", () => {
  if (process.platform === "win32") return;

  return run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-project-" });
        const root = paths.join(parent, "project");
        const literalBackslashes = "..\\outside\\escaped.ts";

        yield* fs.makeDirectory(root);
        yield* fs.makeDirectory(paths.join(parent, "outside"));
        yield* fs.writeFileString(paths.join(root, literalBackslashes), "inside\n");
        yield* fs.writeFileString(paths.join(parent, "outside/escaped.ts"), "outside\n");

        const project: Project = {
          root,
          configPath: paths.join(root, ".antisprawl/config.jsonc"),
          configHash: "test",
          include: ["*.ts"],
          exclude: [],
          diagnostics: [],
        };

        const discovered = yield* Effect.gen(function* () {
          const testFs = yield* FileSystem.FileSystem;

          // Defensive adapter case: Effect's current Linux glob does not surface this filename.
          return yield* discoverSourcePaths(project).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...testFs,
              glob: () => Effect.succeed([literalBackslashes]),
              realPath: (path) => Effect.succeed(path),
            }),
          );
        });

        expect(discovered).toEqual([literalBackslashes]);
        expect(yield* fs.readFileString(paths.join(root, discovered[0]!))).toBe("inside\n");
      }),
    ),
  );
});
