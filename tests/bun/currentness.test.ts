import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Parser } from "web-tree-sitter";
import { indexProject } from "../../src/app.ts";
import { structuralIndexScenario } from "../acceptance/structural-index.scenario.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("a source change during parsing does not update the Index", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-currentness-"));
  const sourcePath = join(root, "src/jobs.ts");

  try {
    for (const [path, contents] of Object.entries({
      [structuralIndexScenario.configPath]: structuralIndexScenario.config,
      ...structuralIndexScenario.files,
    })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Bun.write(join(root, path), contents);
    }

    await run(indexProject(root));

    const indexPath = join(root, ".antisprawl/index.sqlite");
    const before = await Bun.file(indexPath).bytes();

    await Bun.write(sourcePath, "export function beforeParse() { return 1; }\n");

    const parseDescriptor = Object.getOwnPropertyDescriptor(Parser.prototype, "parse");

    if (parseDescriptor?.value === undefined) throw new Error("Parser.parse is unavailable.");

    const originalParse: Parser["parse"] = parseDescriptor.value;

    const parse = spyOn(Parser.prototype, "parse").mockImplementation(function (
      this: Parser,
      callback,
      oldTree,
      options,
    ) {
      writeFileSync(sourcePath, "export function duringParse() { return 2; }\n");

      return originalParse.call(this, callback, oldTree, options);
    });

    try {
      const result = await run(Effect.result(indexProject(root)));

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: "source_changed_during_index" });
      }

      expect(await Bun.file(indexPath).bytes()).toEqual(before);
    } finally {
      parse.mockRestore();
    }

    const output = await run(indexProject(root));

    expect(output.work).toEqual({
      files: { indexed: 1, reused: 0 },
      symbols: { indexed: 1, reused: 0 },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unchanged content hashes skip TypeScript reprocessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "antisprawl-currentness-"));

  try {
    for (const [path, contents] of Object.entries({
      [structuralIndexScenario.configPath]: structuralIndexScenario.config,
      ...structuralIndexScenario.files,
    })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await Bun.write(join(root, path), contents);
    }

    await run(indexProject(root));

    const parse = spyOn(Parser.prototype, "parse");

    try {
      const output = await run(indexProject(root));

      expect(parse).not.toHaveBeenCalled();
      expect(output.work).toEqual({
        files: { indexed: 0, reused: 1 },
        symbols: { indexed: 0, reused: 1 },
      });
    } finally {
      parse.mockRestore();
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
