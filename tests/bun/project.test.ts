import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSourcePaths, resolveProject, type Project } from "../../src/project.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("the nearest Project uses same-directory config precedence", async () => {
  const outer = await mkdtemp(join(tmpdir(), "antisprawl-project-"));
  const root = join(outer, "nested");
  const child = join(root, "src");

  try {
    await mkdir(join(outer, ".antisprawl"));
    await Bun.write(
      join(outer, ".antisprawl/config.jsonc"),
      '{"version":1,"sources":{"include":["outer/**/*.ts"]}}',
    );
    await mkdir(join(root, ".antisprawl"), { recursive: true });
    await mkdir(child);
    await Bun.write(
      join(root, ".antisprawl/config.jsonc"),
      `{
        // Omitted embedding selects Structural-only mode.
        "version": 1,
        "sources": { "include": ["chosen/**/*.ts"] },
      }`,
    );

    for (const name of [".antisprawl/config.json", ".antisprawl.jsonc", ".antisprawl.json"]) {
      await Bun.write(join(root, name), '{"version":1,"sources":{"include":["ignored/**/*.ts"]}}');
    }

    const project = await run(resolveProject(child));

    expect(project).toMatchObject({
      root,
      configPath: join(root, ".antisprawl/config.jsonc"),
      include: ["chosen/**/*.ts"],
      exclude: [],
      diagnostics: [
        { severity: "warning", code: "config_shadowed", path: ".antisprawl/config.json" },
        { severity: "warning", code: "config_shadowed", path: ".antisprawl.jsonc" },
        { severity: "warning", code: "config_shadowed", path: ".antisprawl.json" },
      ],
    });
  } finally {
    await rm(outer, { force: true, recursive: true });
  }
});

test("source discovery includes TypeScript and declaration extensions only", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-project-"));

  try {
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
      await Bun.write(join(root, path), "export {}\n");
    }

    const project: Project = {
      root,
      configPath: join(root, ".antisprawl/config.jsonc"),
      configHash: "test",
      include: ["*"],
      exclude: ["excluded.ts"],
      diagnostics: [],
    };

    expect(await run(discoverSourcePaths(project))).toEqual([
      "common.cts",
      "module.mts",
      "source.ts",
      "types.d.cts",
      "types.d.mts",
      "types.d.ts",
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("source includes cannot escape the Project", async () => {
  const parent = await mkdtemp(join(tmpdir(), "antisprawl-project-"));
  const root = join(parent, "project");

  try {
    await mkdir(root);
    await mkdir(join(parent, "outside"));
    await Bun.write(join(parent, "outside/escaped.ts"), "export function escaped() {}\n");

    const project: Project = {
      root,
      configPath: join(root, ".antisprawl/config.jsonc"),
      configHash: "test",
      include: ["../outside/**/*.ts"],
      exclude: [],
      diagnostics: [],
    };

    const error = await run(Effect.flip(discoverSourcePaths(project)));

    expect(error).toMatchObject({ code: "source_outside_project" });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("source symlinks cannot escape the Project", async () => {
  const parent = await mkdtemp(join(tmpdir(), "antisprawl-project-"));
  const root = join(parent, "project");
  const outside = join(parent, "outside");

  try {
    await mkdir(root);
    await mkdir(outside);
    await Bun.write(join(outside, "escaped.ts"), "export function escaped() {}\n");
    await symlink(outside, join(root, "linked"));

    const project: Project = {
      root,
      configPath: join(root, ".antisprawl/config.jsonc"),
      configHash: "test",
      include: ["linked/**/*.ts"],
      exclude: [],
      diagnostics: [],
    };

    const error = await run(Effect.flip(discoverSourcePaths(project)));

    expect(error).toMatchObject({ code: "source_outside_project" });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

test("glob adapter paths preserve literal POSIX backslashes", async () => {
  if (process.platform === "win32") return;

  const parent = await mkdtemp(join(tmpdir(), "antisprawl-project-"));
  const root = join(parent, "project");
  const literalBackslashes = "..\\outside\\escaped.ts";

  try {
    await mkdir(root);
    await mkdir(join(parent, "outside"));
    await Bun.write(join(root, literalBackslashes), "inside\n");
    await Bun.write(join(parent, "outside/escaped.ts"), "outside\n");

    const project: Project = {
      root,
      configPath: join(root, ".antisprawl/config.jsonc"),
      configHash: "test",
      include: ["*.ts"],
      exclude: [],
      diagnostics: [],
    };

    const paths = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        // Defensive adapter case: Effect's current Linux glob does not surface this filename.
        return yield* discoverSourcePaths(project).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            glob: () => Effect.succeed([literalBackslashes]),
            realPath: (path) => Effect.succeed(path),
          }),
        );
      }),
    );

    expect(paths).toEqual([literalBackslashes]);
    expect(await Bun.file(join(root, paths[0]!)).text()).toBe("inside\n");
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
