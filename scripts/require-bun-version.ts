const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();

const expected = packageJson.packageManager?.match(/^bun@(.+)$/)?.[1];

if (!expected || process.versions.bun !== expected) {
  console.error(
    `Expected Bun ${expected ?? "version in package.json"}, got ${process.versions.bun}.`,
  );
  process.exit(1);
}
