#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sqliteVecHost } from "../packages/cli/src/sqlite-vec-target.ts";
import provenance from "../packages/cli/vendor/sqlite-vec/provenance.json" with { type: "json" };
import cliPackage from "../packages/cli/package.json" with { type: "json" };
import piPackage from "../packages/pi/package.json" with { type: "json" };

type Target = {
  readonly bun: string;
  readonly npm: string;
  readonly os: string;
  readonly cpu: string;
  readonly archive: "tar.gz" | "zip";
  readonly binary: string;
};

const launcher = `#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const packages = {
  "linux x64": "@antisprawl/linux-x64",
  "linux arm64": "@antisprawl/linux-arm64",
  "darwin x64": "@antisprawl/darwin-x64",
  "darwin arm64": "@antisprawl/darwin-arm64",
  "win32 x64": "@antisprawl/windows-x64",
};

const name = packages[\`\${process.platform} \${process.arch}\`];
if (!name) {
  console.error(\`antisprawl does not support \${process.platform}/\${process.arch}.\`);
  process.exit(1);
}

const binary = process.platform === "win32" ? "antisprawl.exe" : "antisprawl";
let directory;
try {
  directory = dirname(require.resolve(name + "/package.json"));
} catch {
  console.error("antisprawl: missing optional package " + name + ". Reinstall without --omit=optional.");
  process.exit(1);
}

const exe = join(directory, binary);
if (!existsSync(exe)) {
  console.error("antisprawl: " + binary + " missing from " + name + ".");
  process.exit(1);
}

const result = spawnSync(exe, process.argv.slice(2), { stdio: "inherit", env: process.env, windowsHide: true });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
`;

const run = (command: string, args: string[], cwd: string) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });

  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

const archiveOs = (os: string) => (os === "win32" ? "windows" : os);

const main = () => {
  const root = join(import.meta.dir, "..");
  const publish = process.argv.includes("--publish");
  const githubRelease = process.argv.includes("--github-release");
  const repository = "git+https://github.com/spiritledsoftware/antisprawl.git";
  const cliVersion = cliPackage.version;
  const piVersion = piPackage.version;

  const targets: readonly Target[] = [
    {
      bun: "bun-linux-x64",
      npm: "@antisprawl/linux-x64",
      os: "linux",
      cpu: "x64",
      archive: "tar.gz",
      binary: "antisprawl",
    },
    {
      bun: "bun-linux-arm64",
      npm: "@antisprawl/linux-arm64",
      os: "linux",
      cpu: "arm64",
      archive: "tar.gz",
      binary: "antisprawl",
    },
    {
      bun: "bun-darwin-x64",
      npm: "@antisprawl/darwin-x64",
      os: "darwin",
      cpu: "x64",
      archive: "tar.gz",
      binary: "antisprawl",
    },
    {
      bun: "bun-darwin-arm64",
      npm: "@antisprawl/darwin-arm64",
      os: "darwin",
      cpu: "arm64",
      archive: "tar.gz",
      binary: "antisprawl",
    },
    {
      bun: "bun-windows-x64",
      npm: "@antisprawl/windows-x64",
      os: "win32",
      cpu: "x64",
      archive: "zip",
      binary: "antisprawl.exe",
    },
  ];

  const out = join(root, "dist/release");
  const npmRoot = join(out, "npm");
  const archives = join(out, "archives");
  const entry = join(root, "packages/cli/src/main.ts");
  const optionalDependencies: Record<string, string> = {};

  rmSync(out, { recursive: true, force: true });
  mkdirSync(archives, { recursive: true });

  for (const target of targets) {
    const pkgDir = join(npmRoot, target.npm);
    const outfile = join(pkgDir, target.binary);
    const archiveName = `antisprawl-v${cliVersion}-${archiveOs(target.os)}-${target.cpu}.${target.archive}`;
    const archivePath = join(archives, archiveName);

    const vecTarget = sqliteVecHost(target.os, target.cpu);
    const vecLibrary = vecTarget === undefined ? undefined : provenance.libraries[vecTarget];

    if (vecLibrary === undefined) throw new Error(`missing sqlite-vec for ${target.bun}`);

    mkdirSync(pkgDir, { recursive: true });
    run(
      "bun",
      [
        "build",
        "--compile",
        `--target=${target.bun}`,
        "--asset",
        join(root, "packages/cli/vendor/sqlite-vec", vecLibrary.library),
        `--outfile=${outfile}`,
        entry,
      ],
      root,
    );
    chmodSync(outfile, 0o755);
    writeFileSync(
      join(pkgDir, "package.json"),
      `${JSON.stringify(
        {
          name: target.npm,
          version: cliVersion,
          description: `antisprawl ${target.os}/${target.cpu} executable`,
          os: [target.os],
          cpu: [target.cpu],
          files: [target.binary],
          publishConfig: { access: "public" },
          repository: { type: "git", url: repository },
        },
        null,
        2,
      )}\n`,
    );

    optionalDependencies[target.npm] = cliVersion;

    if (target.archive === "zip") run("zip", ["-qj", archivePath, outfile], root);
    else run("tar", ["-C", pkgDir, "-czf", archivePath, target.binary], root);
  }

  const launcherDir = join(npmRoot, "antisprawl");

  mkdirSync(join(launcherDir, "bin"), { recursive: true });
  writeFileSync(join(launcherDir, "bin/antisprawl"), launcher, { mode: 0o755 });
  writeFileSync(
    join(launcherDir, "package.json"),
    `${JSON.stringify(
      {
        name: "antisprawl",
        version: cliVersion,
        description: "Keep your agent from writing spaghetti code.",
        bin: { antisprawl: "bin/antisprawl" },
        files: ["bin"],
        optionalDependencies,
        publishConfig: { access: "public" },
        repository: { type: "git", url: repository },
        engines: { node: ">=18" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(launcherDir, "README.md"),
    "# antisprawl\n\n`npm install -g antisprawl` installs the native executable for this platform.\n",
  );

  const piDir = join(npmRoot, "@antisprawl/pi");

  mkdirSync(piDir, { recursive: true });
  cpSync(join(root, "packages/pi/src"), join(piDir, "src"), { recursive: true });
  copyFileSync(join(root, "packages/pi/README.md"), join(piDir, "README.md"));
  copyFileSync(join(root, "packages/pi/CONTEXT.md"), join(piDir, "CONTEXT.md"));
  writeFileSync(
    join(piDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@antisprawl/pi",
        version: piVersion,
        description: "Pi extension that checks successful edits for Probable duplicates.",
        keywords: ["pi-package"],
        type: "module",
        files: ["src", "README.md", "CONTEXT.md"],
        publishConfig: { access: "public" },
        peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
        pi: { extensions: ["./src/extension.ts"] },
        repository: { type: "git", url: repository },
      },
      null,
      2,
    )}\n`,
  );

  const sumNames = targets.map(
    (target) => `antisprawl-v${cliVersion}-${archiveOs(target.os)}-${target.cpu}.${target.archive}`,
  );

  const sums = spawnSync("sha256sum", ["--", ...sumNames], { cwd: archives, encoding: "utf8" });

  if (sums.status !== 0) throw new Error("sha256sum failed");

  writeFileSync(
    join(archives, "SHA256SUMS"),
    `${sums.stdout.split("\n").filter(Boolean).sort().join("\n")}\n`,
  );

  if (publish) {
    for (const name of [...targets.map((target) => target.npm), "antisprawl", "@antisprawl/pi"]) {
      run("npm", ["publish", "--access", "public"], join(npmRoot, name));
    }
  }

  if (githubRelease) {
    run(
      "gh",
      [
        "release",
        "create",
        `v${cliVersion}`,
        "--title",
        `v${cliVersion}`,
        "--notes",
        `Unsigned cross-compiled ${cliVersion} CLI archives and npm packages (antisprawl@${cliVersion}, @antisprawl/pi@${piVersion}). Not the v0.1.0 product release.`,
        ...targets.map((target) =>
          join(
            archives,
            `antisprawl-v${cliVersion}-${archiveOs(target.os)}-${target.cpu}.${target.archive}`,
          ),
        ),
        join(archives, "SHA256SUMS"),
      ],
      root,
    );
  }
};

main();
