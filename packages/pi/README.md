# @antisprawl/pi

After a successful Pi `edit` or `write`, run `antisprawl check` on that path and append bounded Findings to the same tool result.

## Manual smoke

From this repo, in a Project that already has an Index:

```
pi -e ./packages/pi/src/extension.ts
```

Edit a TypeScript source file. The original tool result stays; Findings, if any, append after it.
