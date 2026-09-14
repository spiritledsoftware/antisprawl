# Upstream provenance

- Source: <https://github.com/dmmulroy/anti-slop>
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Snapshot: `skills/install-anti-slop/assets/anti-slop/`
- Installed generic plugin: `tools/oxlint/anti-slop/index.ts`
- Installed Effect plugin: `tools/oxlint/anti-slop/effect/index.ts`

## Local deviations

- `shared/dictionary-types.ts` returns `unsafeMembers[0] ?? null` to satisfy this project's `noUncheckedIndexedAccess` TypeScript setting without changing rule behavior.

## Installation

- `@oxlint/plugins` is pinned to `1.83.0`, matching the installed Oxlint version.
- All bundled generic and Effect rules, plus `oxc/no-accumulating-spread`, are enabled at error severity.
- `effect` is installed as an application dependency.
- Oxlint and Oxfmt ignore agent-tooling directories and this vendored plugin.

## Verification

- Oxlint accepted a representative `flatMap` fixture and rejected a representative `filter(...).map(...)` fixture with `anti-slop/no-array-filter-map`.
- Oxlint accepted a representative `Predicate.isTagged` fixture and rejected a manual `_tag` comparison with `anti-slop-effect/no-manual-tag-comparison`.
- Format checking, linting, and typechecking pass after the local TypeScript compatibility fix.
- `bun run verify` reaches Vitest but exits with “No test files found”; this repository had no test files at installation time.
