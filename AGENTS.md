# Antisprawl instructions

## Agent skills

### Issue tracker

For issues, specs, tickets, and wayfinding, use GitHub for `spiritledsoftware/antisprawl`; read `docs/agents/issue-tracker.md`.

### Triage labels

For issue triage, use the five default canonical labels; read `docs/agents/triage-labels.md`.

### Domain docs

Before codebase exploration or domain and architecture changes, read `docs/agents/domain.md`; this repository uses a single-context layout.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Reference repositories

The `bun install` command materializes these read-only references in `.repos/`.
Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                | Path            | Useful for                                                                       |
| --------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------- |
| [`Effect-TS/effect`](https://github.com/Effect-TS/effect) | `.repos/effect` | Effect 4 runtime, Schema, FileSystem/Path, CLI, and SQL APIs used by Antisprawl. |
