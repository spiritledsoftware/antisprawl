import { describe, expect, it } from "bun:test";
import type { ExtractedSymbol } from "../../src/language.ts";
import { representSymbol } from "../../src/representation.ts";

const symbol = (identifier: string, literal: string): ExtractedSymbol => ({
  key: "example\u0000function\u00000:10",
  qualifiedName: "example",
  kind: "function",
  startByte: 0,
  endByte: 10,
  startRow: 0,
  startColumn: 0,
  endRow: 0,
  endColumn: 10,
  bodyTokenCount: 3,
  tokens: [
    { type: "identifier", role: "", text: identifier, normalized: "$identifier" },
    { type: "+", role: "", text: "+", normalized: "+" },
    { type: "number", role: "", text: literal, normalized: "$number" },
  ],
});

describe("Structural representation", () => {
  it("keeps renames out of normalized fingerprints without storing token text", () => {
    const first = representSymbol(symbol("ready", "1"));
    const renamed = representSymbol(symbol("eligible", "2"));

    expect(first.strictHash).not.toBe(renamed.strictHash);
    expect(first.normalizedHash).toBe(renamed.normalizedHash);
    expect(first.orderedTokenHashes).toEqual(renamed.orderedTokenHashes);
    expect(first.qgramHashes).toEqual(renamed.qgramHashes);
    expect(new TextDecoder().decode(first.orderedTokenHashes)).not.toContain("ready");
  });

  it("builds a versioned comment-free Embedding input", () => {
    const represented = representSymbol(symbol("ready", "1"));

    expect(represented.embeddingInput).toBe("typescript\nready + 1");
    expect(represented.embeddingHash).toBe(
      "2ac9e1f659f7d3daff9a9ef948660be29683d3ecf0cc62e4fd164cbaf51c047c",
    );
  });
});
