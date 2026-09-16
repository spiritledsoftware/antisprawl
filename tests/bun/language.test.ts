import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import { Parser } from "web-tree-sitter";
import { loadBundledTypeScriptGrammar, parseTypeScript } from "../../src/language.ts";

test("TypeScript extraction keeps supported recursive named Symbols", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grammar = yield* loadBundledTypeScriptGrammar();

      const parsed = yield* parseTypeScript(
        grammar,
        `class Worker {
  run() {
    const nested = () => 1;
    return nested();
  }
}
const tools = {
  method() { return 2; },
  closure: () => 3,
  [dynamic]() { return 4; },
};
export default () => 5;
`,
      );

      expect(parsed.hasError).toBe(false);
      expect(parsed.symbols.map(({ qualifiedName, kind }) => ({ qualifiedName, kind }))).toEqual([
        { qualifiedName: "Worker.run", kind: "method" },
        { qualifiedName: "Worker.run.nested", kind: "closure" },
        { qualifiedName: "tools.method", kind: "method" },
        { qualifiedName: "tools.closure", kind: "closure" },
      ]);
    }),
  ));

test("Antisprawl sources remain parseable with unambiguous Symbol identities", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grammar = yield* loadBundledTypeScriptGrammar();
      const root = Bun.fileURLToPath(new URL("../..", import.meta.url));

      const paths = yield* Effect.promise(() =>
        Array.fromAsync(new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })),
      );

      for (const path of paths) {
        const source = yield* Effect.promise(() =>
          Bun.file(new URL(`../../${path}`, import.meta.url)).text(),
        );

        const parsed = yield* parseTypeScript(grammar, source);
        const counts = new Map<string, number>();

        for (const symbol of parsed.symbols) {
          if (symbol.bodyTokenCount >= 20) {
            counts.set(symbol.qualifiedName, (counts.get(symbol.qualifiedName) ?? 0) + 1);
          }
        }

        const ambiguous = [...counts].flatMap(([name, count]) => (count > 1 ? [name] : []));

        expect({ hasError: parsed.hasError, ambiguous }, path).toEqual({
          hasError: false,
          ambiguous: [],
        });
      }
    }),
  ));

test("TypeScript parsing releases native resources when setup fails", () => {
  const remove = spyOn(Parser.prototype, "delete");

  return Effect.runPromise(
    Effect.gen(function* () {
      const grammar = yield* loadBundledTypeScriptGrammar();

      yield* Effect.flip(parseTypeScript({ ...grammar, query: "(" }, "export function valid() {}"));
      expect(remove).toHaveBeenCalledTimes(1);
    }).pipe(Effect.ensuring(Effect.sync(() => remove.mockRestore()))),
  );
});

test("TypeScript declarations have no body tokens", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const grammar = yield* loadBundledTypeScriptGrammar();

      const parsed = yield* parseTypeScript(
        grammar,
        `declare function load(path: string): void;
interface Service {
  run(input: string): void;
}
`,
      );

      expect(
        parsed.symbols.map(({ qualifiedName, kind, bodyTokenCount }) => ({
          qualifiedName,
          kind,
          bodyTokenCount,
        })),
      ).toEqual([
        { qualifiedName: "load", kind: "declaration", bodyTokenCount: 0 },
        { qualifiedName: "Service.run", kind: "declaration", bodyTokenCount: 0 },
      ]);
    }),
  ));
