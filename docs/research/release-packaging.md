# Cross-platform release packaging

## Question

What should Antisprawl publish for a cross-platform `v0.1.0` release, and how should CI and npm installation select the right executable without making Node or Bun a prerequisite for direct downloads?

This is a packaging recommendation, not an implementation. The repository currently has no explicit Bun toolchain pin; `@types/bun` is a dependency but does not pin the compiler/runtime.

## Executive answer

Publish **six** native standalone executables, one per supported OS/CPU pair:

| OS            | CPU       | Bun compile target                            | v0.1.0 |
| ------------- | --------- | --------------------------------------------- | ------ |
| Linux (glibc) | x64       | `bun-linux-x64`                               | ship   |
| Linux (glibc) | arm64     | `bun-linux-arm64`                             | ship   |
| macOS         | x64       | `bun-darwin-x64`                              | ship   |
| macOS         | arm64     | `bun-darwin-arm64`                            | ship   |
| Windows       | x64       | `bun-windows-x64`                             | ship   |
| Linux (musl)  | x64/arm64 | `bun-linux-x64-musl` / `bun-linux-arm64-musl` | defer  |
| Windows       | arm64     | `bun-windows-arm64`                           | defer  |

These target names and the fact that `--compile` bundles the Bun runtime and dependencies are documented by Bun in [Compile and standalone executables](https://bun.sh/docs/bundler/executables). Do not attempt a “universal” executable: Bun explicitly documents per-target compilation rather than a universal binary.

Ship each executable in a versioned archive, a sorted aggregate `SHA256SUMS`, and (optionally) a sidecar checksum for each archive. Run a smoke/acceptance command on the matching native CI runner before the archive leaves that job. An aggregator must verify the complete six-target set and checksums before creating the GitHub Release.

Offer one npm convenience package with platform-specific optional packages. The npm package is a launcher and therefore needs a JavaScript runtime; the downloaded release executable is the no-Node/no-Bun path.

## Platform support and constraints

Bun's [installation requirements](https://bun.sh/docs/installation) define the runtime floor that a compiled Bun executable inherits:

- glibc Linux builds require glibc 2.17 or newer; Bun documents separate musl builds for musl-based distributions.
- Bun's x64 CPU requirement is Nehalem/SSE4.2 (AMD Bulldozer or newer).
- Bun documents macOS 13 or newer and Windows 10 version 1809 or newer.
- Bun documents Linux kernel support as old as 3.10, with 5.6 recommended.

Those are **candidate support floors**, not proof supplied by a modern hosted runner. A successful run on `ubuntu-24.04`, `macos-15`, or `windows-2025` proves that target on that image only. Add a compatibility VM/container job for every minimum floor that the project promises before publishing those floors as a user-facing guarantee. In particular, exercise an old glibc environment rather than inferring it from the newest Ubuntu image.

The v0.1.0 support boundary is therefore:

- Linux glibc x64 and arm64.
- macOS x64 and arm64.
- Windows x64.
- No promise for Linux musl, Windows arm64, 32-bit systems, or CPUs below Bun's x64 requirement.

Revisit musl and Windows arm64 only when a reproducible build, native smoke test, and compatibility test are available. Bun lists the musl and Windows-arm64 target names in its executable documentation, so deferring them is a release policy decision rather than pretending those targets do not exist.

## Artifact and checksum layout

Use the release tag as the version source. For `v0.1.0`, publish exactly these release assets:

```text
antisprawl-v0.1.0-linux-x64.tar.gz
antisprawl-v0.1.0-linux-arm64.tar.gz
antisprawl-v0.1.0-darwin-x64.tar.gz
antisprawl-v0.1.0-darwin-arm64.tar.gz
antisprawl-v0.1.0-windows-x64.zip
SHA256SUMS
```

Each Unix archive should preserve an executable named `antisprawl`; the Windows archive should contain `antisprawl.exe`. A top-level README and license may be added if release policy requires them, but avoid platform-specific nested layouts unless the installer/documentation needs one. Tar archives preserve Unix executable bits; a zip is the least surprising Windows format.

The aggregate should contain one line per archive, sorted by filename, for example:

```text
<sha256>  antisprawl-v0.1.0-darwin-arm64.tar.gz
...
```

Generate it from the final archive bytes, not from the executable before archiving. Verify it in the aggregator with the platform-appropriate SHA-256 checker before upload. Unix jobs can use `sha256sum` (or `shasum -a 256` on macOS); Windows can use `Get-FileHash -Algorithm SHA256`; the aggregator can normalize all checksums on Linux. Optional `<archive>.sha256` files are convenient for one-file downloads, while `SHA256SUMS` is the portable, auditable source of truth.

GitHub also records a SHA-256 asset `digest` when an asset is uploaded ([release asset API](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)). Keep the checked-in/downloadable `SHA256SUMS` anyway: it travels with mirrors and can be checked without an API call.

Build the executable with the corresponding Bun target, using the project's real entry point in implementation:

```text
bun build --compile --target bun-linux-x64 --outfile antisprawl <entrypoint>
```

Repeat for each target in the table. Bun documents `--outfile`, target names, and the standalone bundle behavior in [its executable guide](https://bun.sh/docs/bundler/executables). Do not rely on a copied `node_modules` tree from another OS/CPU; install dependencies in the job that builds the target.

Create the release from an already-pushed, verified tag (for example, `gh release create v0.1.0 --verify-tag`). GitHub releases are tag-based and accept release assets under [the release model](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). Asset names must be unique; the REST API documents duplicate-name failures and raw binary uploads in [Create a release](https://docs.github.com/en/rest/releases/releases#create-a-release). Keep asset names deterministic so reruns fail visibly rather than silently replacing a different artifact.

## npm convenience package

Publish one launcher package (the eventual npm scope/name is a release-owner decision), for example:

```text
antisprawl/
  bin/antisprawl                 # small JS launcher
  package.json                   # bin + exact optionalDependencies

platform packages (examples):
  @antisprawl/linux-x64          # antisprawl only
  @antisprawl/linux-arm64
  @antisprawl/darwin-x64
  @antisprawl/darwin-arm64
  @antisprawl/windows-x64        # antisprawl.exe only
```

The [npm `package.json` reference](https://docs.npmjs.com/cli/v11/configuring-npm/package-json) supports the required shape:

- Put each platform package in `optionalDependencies` of the launcher, all at the exact release version.
- Set `os` and `cpu` on each platform package. Add `libc` only when musl packages are actually supported.
- Keep platform packages data-only (the matching executable and metadata) and do not give them their own `bin` entry; only the launcher owns the `antisprawl` command.
- Use `files` to exclude source, CI output, and unrelated files from each npm tarball.
- npm may omit optional dependencies, including with `--omit=optional`; the launcher must report a clear unsupported/missing-package error instead of crashing with an opaque module error.

The launcher should use a fixed process map from `process.platform` and `process.arch` to package name and executable path, then `require.resolve` the selected binary and invoke it with `spawnSync`/`execFile` using `shell: false`, inherited stdio, the caller's arguments, and the caller's environment. Propagate the child exit status and signal. This follows the small, proven pattern in [esbuild's platform selector](https://github.com/evanw/esbuild/blob/f6058f8364fe7ab91ca57a83e02577ed74c9cae4/lib/npm/node-platform.ts) and its [optional-package/checksum handling](https://github.com/evanw/esbuild/blob/f6058f8364fe7ab91ca57a83e02577ed74c9cae4/lib/npm/node-install.ts). [Biome's launcher](https://github.com/biomejs/biome/blob/a6daf0fe2de78af7c45c2c1a1c49763d318e2f79/packages/@biomejs/biome/bin/biome) is a second reference for `require.resolve`, `shell: false`, argument/environment forwarding, and clear errors; its [manifest](https://github.com/biomejs/biome/blob/a6daf0fe2de78af7c45c2c1a1c49763d318e2f79/packages/@biomejs/biome/package.json) shows the `bin` plus platform-optional-dependency arrangement.

Do not use `postinstall` to download a binary. Optional packages should contain the binary at publish time, so offline installs and locked-down CI remain useful. Test installation and invocation with npm and Bun, including a deliberately omitted optional dependency and an unsupported `os`/`cpu` combination. The launcher's JavaScript runtime requirement should be stated in `engines`; it does not weaken the direct-download promise.

An `ANTISPRAWL_BINARY` escape hatch can be added if local development needs a manually selected binary, but it is not required for the first release. If added, validate it as a path and still invoke it with `shell: false`; never interpolate it into a shell command.

## CI matrix and release flow

Use two workflows: ordinary verification for pull requests/pushes, and a tag-driven release workflow. GitHub's [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) provides matrix jobs and tag filters; keep release and ordinary verification separate so a push cannot accidentally publish.

The release build matrix should be an explicit `include` list (not generated from a broad Cartesian product):

| `target`           | Runner label       | Archive   | Native check |
| ------------------ | ------------------ | --------- | ------------ |
| `bun-linux-x64`    | `ubuntu-24.04`     | `.tar.gz` | yes          |
| `bun-linux-arm64`  | `ubuntu-24.04-arm` | `.tar.gz` | yes          |
| `bun-darwin-x64`   | `macos-15-intel`   | `.tar.gz` | yes          |
| `bun-darwin-arm64` | `macos-15`         | `.tar.gz` | yes          |
| `bun-windows-x64`  | `windows-2025`     | `.zip`    | yes          |

GitHub documents these hosted runner labels in [the runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Pin explicit labels rather than `-latest`: the [runner-images project](https://github.com/actions/runner-images) notes that images are updated regularly and moving labels change over time. Confirm arm64 availability and repository plan limits when enabling the workflow; fail clearly if a requested arm runner is unavailable.

Every matrix job should:

1. Check out the exact tag commit.
2. Install the exact pinned Bun version.
3. Run `bun ci` (the frozen-lockfile CI install documented in [Bun's install docs](https://bun.sh/docs/pm/cli/install)) before building.
4. Compile with its one target and deterministic output name.
5. Package the binary, preserving Unix mode bits.
6. Compute and locally verify a SHA-256 checksum.
7. Run a native `--version`/help smoke test plus the smallest real acceptance invocation.
8. Upload one uniquely named immutable workflow artifact containing the archive, checksum, and target metadata.

Set `fail-fast: false`; one target's failure must not cancel the evidence for other targets. `upload-artifact@v4` artifacts are immutable, require unique names, and expose a SHA-256 digest; GitHub documents upload/download validation in [store and share workflow data](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/store-and-share-data).

An aggregator job, gated on all matrix jobs, should download by those unique names, verify:

- all five shipping targets are present and no deferred target is accidentally included;
- each archive's checksum matches its sidecar and the recomputed hash;
- archive contents and executable mode/name are correct;
- the aggregate `SHA256SUMS` is sorted and complete;
- the release tag points at the checked-out commit.

Only after those checks should it create/upload the GitHub Release. Grant the release job the minimal `contents: write` permission required by the [release API](https://docs.github.com/en/rest/releases/releases#create-a-release), and do not let build jobs publish directly. A rerun must either use a fresh release or explicitly clean up the old one; it must not overwrite an asset under a duplicate name.

## Runtime and release decisions to make explicit

1. **Bun pin:** add one repository source of truth (`.bun-version` or `packageManager`) and configure `oven-sh/setup-bun@v2` with an exact version or version file. The action documents that, absent a pin, it may use package metadata or latest; [setup-bun's README](https://github.com/oven-sh/setup-bun#readme) describes both pinning inputs. Pin before accepting reproducible release evidence.
2. **Compiler/runtime provenance:** record Bun version, target, source commit, and checksum in CI logs/metadata. A compiled binary embeds Bun, so changing Bun changes the produced artifact even if app source is unchanged.
3. **Configuration autoload:** verify the standalone executable's `.env`/`bunfig` autoload behavior from the Bun executable docs and choose deterministic CLI behavior. Do not let a release smoke test accidentally depend on a developer's working-directory config.
4. **Signing:** decide whether macOS code signing/notarization and Windows signing are required for the intended distribution. Unsigned binaries may trigger platform trust prompts; signing identity, secrets, and notarization are release-policy work, not reasons to claim an unverified target.
5. **Compatibility proof:** add old-glibc and any promised old macOS/Windows checks before documenting the minimums above as guarantees. Hosted runners alone test current images.
6. **npm support policy:** set the launcher Node engine floor, test npm and Bun, document `--omit=optional` as unsupported for invocation, and ensure an omitted package gives an actionable message.
7. **Release recovery:** define whether a failed publication is deleted/recreated or resumed. GitHub rejects duplicate asset names, so this must be scripted rather than handled manually.

## Implementation gates

A release implementation is ready when all of the following are true:

- [ ] Bun version is explicitly pinned and `bun ci` succeeds from a clean checkout.
- [ ] Matrix builds produce exactly the five shipping targets using the target names above.
- [ ] Each native smoke/acceptance check runs on its matching OS/CPU runner.
- [ ] Archives have deterministic names, executable modes, and no accidental build-tree files.
- [ ] The aggregator rejects missing, extra, unsorted, or checksum-mismatched assets.
- [ ] `SHA256SUMS` verifies from a fresh download before publication.
- [ ] Release creation is tag-filtered, least-privilege, and safe to rerun without duplicate names.
- [ ] npm optional packages install/select correctly on all five platforms; missing optional packages fail clearly.
- [ ] Direct archive execution is tested without Node or Bun installed.
- [ ] Support documentation distinguishes tested image versions from compatibility floors.
- [ ] Musl, Windows arm64, signing, and compatibility VMs are either implemented and tested or explicitly listed as deferred.

## Sources

All normative claims above link to primary vendor/project documentation. The two source-code examples are pinned immutable commits, not moving branch links:

- [Bun standalone executables](https://bun.sh/docs/bundler/executables)
- [Bun installation requirements](https://bun.sh/docs/installation)
- [oven-sh/setup-bun](https://github.com/oven-sh/setup-bun#readme)
- [Bun install](https://bun.sh/docs/pm/cli/install) and [Bun lockfile](https://bun.sh/docs/pm/lockfile)
- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [GitHub runner images](https://github.com/actions/runner-images)
- [About GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Create a release](https://docs.github.com/en/rest/releases/releases#create-a-release)
- [Get a release asset](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)
- [Store and share workflow data](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/store-and-share-data)
- [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [npm `package.json`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json)
- [esbuild platform selector, commit `f6058f8`](https://github.com/evanw/esbuild/blob/f6058f8364fe7ab91ca57a83e02577ed74c9cae4/lib/npm/node-platform.ts)
- [esbuild installer/checksum handling, commit `f6058f8`](https://github.com/evanw/esbuild/blob/f6058f8364fe7ab91ca57a83e02577ed74c9cae4/lib/npm/node-install.ts)
- [Biome launcher, commit `a6daf0f`](https://github.com/biomejs/biome/blob/a6daf0fe2de78af7c45c2c1a1c49763d318e2f79/packages/@biomejs/biome/bin/biome)
- [Biome package manifest, commit `a6daf0f`](https://github.com/biomejs/biome/blob/a6daf0fe2de78af7c45c2c1a1c49763d318e2f79/packages/@biomejs/biome/package.json)
