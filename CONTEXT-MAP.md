# Context Map

## Contexts

- [Antisprawl](./docs/CONTEXT.md): shared product language for duplicate-evidence analysis
- [CLI](./packages/cli/CONTEXT.md): executable delivery of Antisprawl analysis
- [Pi](./packages/pi/CONTEXT.md): Pi harness mapping onto Antisprawl

## Relationships

- **CLI → Antisprawl**: the CLI implements Antisprawl analysis and adds no terms of its own.
- **Pi → Antisprawl**: maps a Pi session to Agent session and a successful edit or write to one Edit batch; does not own Project or Index.
