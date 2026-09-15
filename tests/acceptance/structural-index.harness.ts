import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { structuralIndexScenario } from "./structural-index.scenario.ts";

const Json = Schema.fromJsonString(Schema.Unknown);

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const verifyStructuralIndex = Effect.fn("Acceptance.verifyStructuralIndex")(function* (
  runIndex: (projectRoot: string) => CommandResult,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-index-" });

  for (const [path, contents] of Object.entries({
    [structuralIndexScenario.configPath]: structuralIndexScenario.config,
    ...structuralIndexScenario.files,
  })) {
    const absolutePath = paths.join(projectRoot, path);

    yield* fs.makeDirectory(paths.dirname(absolutePath), { recursive: true });
    yield* fs.writeFileString(absolutePath, contents);
  }

  const first = runIndex(projectRoot);

  expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });

  const firstOutput = yield* Schema.decodeEffect(Json)(first.stdout);

  expect(firstOutput).toEqual(structuralIndexScenario.firstOutput);

  const indexPath = paths.join(projectRoot, ".antisprawl/index.sqlite");
  const index = new Database(indexPath, { readonly: true });

  expect(index.query("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(index.query("select key, value from metadata order by key").all()).toEqual(
    structuralIndexScenario.index.metadata,
  );
  expect(index.query("select * from files order by path").all()).toEqual(
    structuralIndexScenario.index.files,
  );
  expect(
    index
      .query(`
          select
            file_path,
            symbol_key,
            qualified_name,
            kind,
            start_byte,
            end_byte,
            start_row,
            start_column,
            end_row,
            end_column,
            token_count,
            strict_hash,
            normalized_hash,
            typeof(ordered_token_hashes) as ordered_type,
            length(ordered_token_hashes) as ordered_bytes,
            typeof(qgram_hashes) as qgram_type,
            length(qgram_hashes) as qgram_bytes
          from symbols
          order by file_path, symbol_key
        `)
      .all(),
  ).toEqual(structuralIndexScenario.index.symbols);
  index.close();

  const databaseText = new TextDecoder().decode(yield* fs.readFile(indexPath));

  for (const sourceToken of ["cancelledAt", "ready", "queued"]) {
    expect(databaseText).not.toContain(sourceToken);
  }

  const second = runIndex(projectRoot);

  expect({ exitCode: second.exitCode, stderr: second.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  expect(yield* Schema.decodeEffect(Json)(second.stdout)).toEqual({
    ...structuralIndexScenario.firstOutput,
    work: {
      files: { indexed: 0, reused: 1 },
      symbols: { indexed: 0, reused: 1 },
    },
  });
});
