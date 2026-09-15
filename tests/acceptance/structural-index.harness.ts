import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { structuralIndexScenario } from "./structural-index.scenario.ts";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export const verifyStructuralIndex = async (
  runIndex: (projectRoot: string) => CommandResult | Promise<CommandResult>,
) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "antisprawl-index-"));

  try {
    for (const [path, contents] of Object.entries({
      [structuralIndexScenario.configPath]: structuralIndexScenario.config,
      ...structuralIndexScenario.files,
    })) {
      const absolutePath = join(projectRoot, path);

      await mkdir(dirname(absolutePath), { recursive: true });
      await Bun.write(absolutePath, contents);
    }

    const first = await runIndex(projectRoot);

    expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const firstOutput = JSON.parse(first.stdout);

    expect(firstOutput).toEqual(structuralIndexScenario.firstOutput);

    const indexPath = join(projectRoot, ".antisprawl/index.sqlite");
    const index = new Database(indexPath, { readonly: true });

    expect(index.query("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(index.query("select key, value from metadata order by key").all()).toEqual([
      ...structuralIndexScenario.index.metadata,
    ]);
    expect(index.query("select * from files order by path").all()).toEqual([
      ...structuralIndexScenario.index.files,
    ]);
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
    ).toEqual([...structuralIndexScenario.index.symbols]);
    index.close();

    const databaseText = new TextDecoder().decode(await Bun.file(indexPath).arrayBuffer());

    for (const sourceToken of ["cancelledAt", "ready", "queued"]) {
      expect(databaseText).not.toContain(sourceToken);
    }

    const second = await runIndex(projectRoot);

    expect({ exitCode: second.exitCode, stderr: second.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(second.stdout)).toEqual({
      ...structuralIndexScenario.firstOutput,
      work: {
        files: { indexed: 0, reused: 1 },
        symbols: { indexed: 0, reused: 1 },
      },
    });
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
};
