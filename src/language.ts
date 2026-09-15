import coreWasmPath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import grammarWasmPath from "../assets/grammars/typescript/tree-sitter-typescript.wasm" with { type: "file" };
import manifestPath from "../assets/grammars/typescript/manifest.jsonc" with { type: "file" };
import queryPath from "../assets/grammars/typescript/symbols.scm" with { type: "file" };
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";
import { appError } from "./errors.ts";

const ManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  language: Schema.Literal("typescript"),
  parser: Schema.Struct({
    commit: Schema.String,
    abi: Schema.Number,
    artifact: Schema.Struct({
      size: Schema.Number,
      sha256: Schema.String,
    }),
  }),
  runtime: Schema.Struct({
    version: Schema.String,
    languageVersion: Schema.Number,
    minimumCompatibleLanguageVersion: Schema.Number,
  }),
  queries: Schema.Struct({
    symbols: Schema.Struct({
      sha256: Schema.String,
    }),
  }),
});

export interface GrammarProvenance {
  readonly language: "typescript";
  readonly runtime: string;
  readonly parserCommit: string;
  readonly parserAbi: number;
  readonly wasmSha256: string;
  readonly querySha256: string;
  readonly manifestSha256: string;
}

export interface ResolvedGrammar {
  readonly bytes: Uint8Array;
  readonly query: string;
  readonly provenance: GrammarProvenance;
}

export interface CanonicalToken {
  readonly type: string;
  readonly role: string;
  readonly text: string;
  readonly normalized: string;
}

export interface ExtractedSymbol {
  readonly key: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
  readonly bodyTokenCount: number;
  readonly tokens: ReadonlyArray<CanonicalToken>;
}

export interface ParsedFile {
  readonly symbols: ReadonlyArray<ExtractedSymbol>;
  readonly hasError: boolean;
}

const sha256 = (value: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

export const loadBundledTypeScriptGrammar = Effect.fn("Language.loadBundledTypeScriptGrammar")(
  function* () {
    const manifestText = yield* Effect.promise(() => Bun.file(manifestPath).text());

    const manifest = yield* Schema.decodeUnknownEffect(ManifestSchema)(
      Bun.JSONC.parse(manifestText),
    ).pipe(
      Effect.mapError(() =>
        appError("grammar_manifest_invalid", "Invalid TypeScript grammar manifest."),
      ),
    );

    const bytes = yield* Effect.promise(() => Bun.file(grammarWasmPath).bytes());

    const query = yield* Effect.promise(() => Bun.file(queryPath).text());

    if (bytes.byteLength !== manifest.parser.artifact.size) {
      return yield* Effect.fail(
        appError("grammar_size_mismatch", "The embedded TypeScript grammar has the wrong size."),
      );
    }

    if (sha256(bytes) !== manifest.parser.artifact.sha256) {
      return yield* Effect.fail(
        appError("grammar_digest_mismatch", "The embedded TypeScript grammar failed verification."),
      );
    }

    if (sha256(query) !== manifest.queries.symbols.sha256) {
      return yield* Effect.fail(
        appError("query_digest_mismatch", "The TypeScript symbol query failed verification."),
      );
    }

    return {
      bytes,
      query,
      provenance: {
        language: manifest.language,
        runtime: manifest.runtime.version,
        parserCommit: manifest.parser.commit,
        parserAbi: manifest.parser.abi,
        wasmSha256: manifest.parser.artifact.sha256,
        querySha256: manifest.queries.symbols.sha256,
        manifestSha256: sha256(manifestText),
      },
    } satisfies ResolvedGrammar;
  },
);

let parserInitialization: Promise<void> | undefined;

const initializeParser = () => {
  parserInitialization ??= Bun.file(coreWasmPath)
    .bytes()
    .then((wasmBinary) => Parser.init({ wasmBinary }));

  return parserInitialization;
};

const externalBinding = (node: Node) => {
  const parent = node.parent;

  if (parent?.type === "variable_declarator" && parent.childForFieldName("value")?.equals(node)) {
    return parent.childForFieldName("name")?.text;
  }

  if (parent?.type === "pair" && parent.childForFieldName("value")?.equals(node)) {
    return parent.childForFieldName("key")?.text;
  }

  if (
    parent?.type === "public_field_definition" &&
    parent.childForFieldName("value")?.equals(node)
  ) {
    return parent.childForFieldName("name")?.text;
  }

  return undefined;
};

const ownerName = (node: Node) => node.childForFieldName("name")?.text ?? externalBinding(node);

const objectOwner = (node: Node) => {
  const parent = node.parent;

  if (parent?.type === "variable_declarator" && parent.childForFieldName("value")?.equals(node)) {
    return parent.childForFieldName("name")?.text;
  }

  if (parent?.type === "pair" && parent.childForFieldName("value")?.equals(node)) {
    return parent.childForFieldName("key")?.text;
  }

  return undefined;
};

const ownersFor = (symbol: Node) => {
  const owners: Array<string> = [];
  let node = symbol.parent;

  while (node !== null) {
    let owner: string | undefined;

    switch (node.type) {
      case "abstract_class_declaration":
      case "class":
      case "class_declaration":
      case "enum_declaration":
      case "function_declaration":
      case "function_signature":
      case "generator_function_declaration":
      case "interface_declaration":
      case "internal_module":
      case "method_definition":
      case "method_signature":
      case "module":
      case "type_alias_declaration":
        owner = ownerName(node);
        break;
      case "arrow_function":
      case "function_expression":
      case "generator_function":
        owner = externalBinding(node) ?? node.childForFieldName("name")?.text;
        break;
      case "object":
        owner = objectOwner(node);
        break;
    }

    if (owner !== undefined) owners.push(owner);
    node = node.parent;
  }

  return owners.reverse();
};

const symbolName = (node: Node) => {
  if (node.type !== "computed_property_name") return node.text;

  const value = node.namedChild(0);

  if (value?.type === "string" || value?.type === "number") return value.text;

  return undefined;
};

const recordNode = (symbol: Node) => {
  const parent = symbol.parent;

  if (
    parent !== null &&
    (parent.type === "pair" ||
      parent.type === "public_field_definition" ||
      parent.type === "variable_declarator") &&
    parent.childForFieldName("value")?.equals(symbol)
  ) {
    return parent;
  }

  return symbol;
};

const normalizedText = (node: Node) => {
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
    case "type_identifier":
      return "$identifier";
    case "number":
      return "$number";
    case "regex":
      return "$regex";
    case "string":
    case "template_string":
      return "$string";
    default:
      return node.text;
  }
};

const tokensFor = (node: Node) => {
  const tokens: Array<CanonicalToken> = [];

  const visit = (current: Node, role: string) => {
    if (current.type.includes("comment")) return;

    if (current.childCount === 0) {
      tokens.push({
        type: current.type,
        role,
        text: current.text,
        normalized: normalizedText(current),
      });

      return;
    }

    for (let index = 0; index < current.childCount; index += 1) {
      const child = current.child(index);

      if (child !== null) visit(child, current.fieldNameForChild(index) ?? "");
    }
  };

  visit(node, "");

  return tokens;
};

const symbolKind = (symbol: Node) => {
  switch (symbol.type) {
    case "function_signature":
    case "method_signature":
    case "abstract_method_signature":
    case "property_signature":
    case "variable_declarator":
      return "declaration";
    case "method_definition":
      return "method";
    case "arrow_function":
    case "function_expression":
    case "generator_function":
      return "closure";
    default:
      return "function";
  }
};

export const parseTypeScript = Effect.fn("Language.parseTypeScript")(function* (
  grammar: ResolvedGrammar,
  source: string,
) {
  return yield* Effect.tryPromise({
    try: async () => {
      await initializeParser();

      const language = await Language.load(grammar.bytes);

      if (language.abiVersion !== grammar.provenance.parserAbi) {
        throw new Error("Parser ABI does not match its manifest.");
      }

      const parser = new Parser();
      let query: Query | undefined;
      let tree: Tree | null = null;

      try {
        query = new Query(language, grammar.query);
        parser.setLanguage(language);
        tree = parser.parse(source);

        if (tree === null) throw new Error("Parser returned no tree.");

        const symbols: Array<ExtractedSymbol> = [];

        for (const match of query.matches(tree.rootNode)) {
          const symbol = match.captures.find((capture) => capture.name === "symbol")?.node;
          const nameNode = match.captures.find((capture) => capture.name === "name")?.node;

          if (symbol === undefined || nameNode === undefined || symbol.hasError) continue;

          const name = symbolName(nameNode);

          if (name === undefined) continue;

          const record = recordNode(symbol);

          const qualifiedName = [...ownersFor(symbol), name].join(".");
          const body = symbol.childForFieldName("body");
          const kind = symbolKind(symbol);

          symbols.push({
            key: `${qualifiedName}\0${kind}\0${record.startIndex}:${record.endIndex}`,
            qualifiedName,
            kind,
            startByte: record.startIndex,
            endByte: record.endIndex,
            startRow: record.startPosition.row,
            startColumn: record.startPosition.column,
            endRow: record.endPosition.row,
            endColumn: record.endPosition.column,
            bodyTokenCount: body === null ? 0 : tokensFor(body).length,
            tokens: tokensFor(record),
          });
        }

        return { symbols, hasError: tree.rootNode.hasError } satisfies ParsedFile;
      } finally {
        tree?.delete();
        query?.delete();
        parser.delete();
      }
    },
    catch: () =>
      appError("typescript_parse_failed", "The TypeScript grammar could not parse the file."),
  });
});
