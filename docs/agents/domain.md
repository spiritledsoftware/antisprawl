# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root, then every CONTEXT it lists.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If the map does not exist, proceed silently. Do not suggest creating it upfront. The domain-modeling workflow creates these files lazily when terminology or decisions are resolved.

## File structure

This is a multi-context repository:

```
/
├── CONTEXT-MAP.md
├── docs/
│   ├── CONTEXT.md
│   └── adr/
└── packages/
    └── cli/
        └── CONTEXT.md
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in the listed CONTEXT that owns it. Shared terms live in Antisprawl (`docs/CONTEXT.md`). Do not drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, either reconsider whether it belongs to the project or note the gap for domain modeling.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007, but worth reopening because…_
