import { expect, spyOn, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { Parser } from "web-tree-sitter";
import { loadBundledTypeScriptGrammar, parseTypeScript } from "../../src/language.ts";

test("TypeScript extraction keeps supported recursive named Symbols", async () => {
  const grammar = await Effect.runPromise(loadBundledTypeScriptGrammar());

  const parsed = await Effect.runPromise(
    parseTypeScript(
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
    ),
  );

  expect(parsed.hasError).toBe(false);
  expect(parsed.symbols.map(({ qualifiedName, kind }) => ({ qualifiedName, kind }))).toEqual([
    { qualifiedName: "Worker.run", kind: "method" },
    { qualifiedName: "Worker.run.nested", kind: "closure" },
    { qualifiedName: "tools.method", kind: "method" },
    { qualifiedName: "tools.closure", kind: "closure" },
  ]);
});

test("TypeScript parsing releases native resources when setup fails", async () => {
  const grammar = await Effect.runPromise(loadBundledTypeScriptGrammar());
  const remove = spyOn(Parser.prototype, "delete");

  try {
    const result = await Effect.runPromise(
      Effect.result(parseTypeScript({ ...grammar, query: "(" }, "export function valid() {}")),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    remove.mockRestore();
  }
});

test("TypeScript declarations have no body tokens", async () => {
  const grammar = await Effect.runPromise(loadBundledTypeScriptGrammar());

  const parsed = await Effect.runPromise(
    parseTypeScript(
      grammar,
      `declare function load(path: string): void;
interface Service {
  run(input: string): void;
}
`,
    ),
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
});
