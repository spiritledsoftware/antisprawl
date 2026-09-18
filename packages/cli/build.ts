import provenance from "./vendor/sqlite-vec/provenance.json" with { type: "json" };
import { sqliteVecHost } from "./src/sqlite-vec-target.ts";

const target = sqliteVecHost(process.platform, process.arch);

const record = target === undefined ? undefined : provenance.libraries[target];

if (record === undefined) {
  throw new Error(`sqlite-vec is not vendored for ${process.platform}/${process.arch}`);
}

const result = Bun.spawnSync(
  [
    "bun",
    "build",
    "--compile",
    "--asset",
    `vendor/sqlite-vec/${record.library}`,
    "src/main.ts",
    "--outfile",
    "dist/antisprawl",
  ],
  { stderr: "inherit", stdout: "inherit" },
);

process.exit(result.exitCode ?? 1);
