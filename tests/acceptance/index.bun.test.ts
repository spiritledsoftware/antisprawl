import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { structuralIndexScenario } from "./structural-index.scenario.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const runIndex = (projectRoot: string) => {
  const process = Bun.spawnSync(["bun", join(repositoryRoot, "src/main.ts"), "index"], {
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

test("index builds and reuses the real TypeScript Structural Index", async () => {
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

    const first = runIndex(projectRoot);
    expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });

    const firstOutput = JSON.parse(first.stdout);
    expect(firstOutput).toEqual({
      protocolVersion: 1,
      command: "index",
      coverage: {
        status: "complete",
        files: { total: 1, current: 1, failed: 0 },
      },
      work: {
        files: { indexed: 1, reused: 0 },
        symbols: { indexed: 1, reused: 0 },
      },
      provenance: {
        bun: "1.4.2",
        indexSchema: 1,
        representation: 1,
        grammar: {
          language: "typescript",
          runtime: "0.27.0",
          parserCommit: "75b3874edb2dc714fb1fd77a32013d0f8699989f",
          parserAbi: 14,
          wasmSha256: "778025db5a8be0e70f8ccc3671e486dfeddd048c25d9e8a70c26de2e1bf6f97d",
          querySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      diagnostics: [],
      findings: [],
    });

    const indexPath = join(projectRoot, ".antisprawl/index.sqlite");
    const index = new Database(indexPath, { readonly: true });
    expect(index.query("pragma integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(index.query("select count(*) as count from files").get()).toEqual({ count: 1 });
    expect(index.query("select count(*) as count from symbols").get()).toEqual({ count: 1 });
    index.close();

    const bytes = await Bun.file(indexPath).arrayBuffer();
    expect(new TextDecoder().decode(bytes)).not.toContain("job.cancelledAt");

    const second = runIndex(projectRoot);
    expect({ exitCode: second.exitCode, stderr: second.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(JSON.parse(second.stdout)).toEqual({
      ...firstOutput,
      work: {
        files: { indexed: 0, reused: 1 },
        symbols: { indexed: 0, reused: 1 },
      },
    });
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});
