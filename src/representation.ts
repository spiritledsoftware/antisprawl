import type { CanonicalToken, ExtractedSymbol } from "./language.ts";

export const representationVersion = 1;

export interface StructuralRepresentation {
  readonly key: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
  readonly tokenCount: number;
  readonly strictHash: string;
  readonly normalizedHash: string;
  readonly orderedTokenHashes: Uint8Array;
  readonly qgramHashes: Uint8Array;
}

const sha256 = (value: Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const tokenDigest = (token: CanonicalToken, normalized: boolean) => {
  const text = normalized ? token.normalized : token.text;

  return new Bun.CryptoHasher("sha256")
    .update(token.type)
    .update("\0")
    .update(token.role)
    .update("\0")
    .update(text)
    .digest("hex");
};

const pack = (hashes: ReadonlyArray<string>) =>
  new Uint8Array(Buffer.concat(hashes.map((hash) => Buffer.from(hash, "hex"))));

export const representSymbol = (symbol: ExtractedSymbol): StructuralRepresentation => {
  // ponytail: SHA-256 per token favors a simple collision-resistant format; benchmark before using narrower hashes.
  const strictTokens = symbol.tokens.map((token) => tokenDigest(token, false));
  const normalizedTokens = symbol.tokens.map((token) => tokenDigest(token, true));
  const qgrams = new Set<string>();

  for (let index = 0; index + 2 < normalizedTokens.length; index += 1) {
    const bytes = pack(normalizedTokens.slice(index, index + 3));

    qgrams.add(sha256(bytes));
  }

  const strictBytes = pack(strictTokens);
  const normalizedBytes = pack(normalizedTokens);

  return {
    key: symbol.key,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    startByte: symbol.startByte,
    endByte: symbol.endByte,
    startRow: symbol.startRow,
    startColumn: symbol.startColumn,
    endRow: symbol.endRow,
    endColumn: symbol.endColumn,
    tokenCount: symbol.bodyTokenCount,
    strictHash: sha256(strictBytes),
    normalizedHash: sha256(normalizedBytes),
    orderedTokenHashes: normalizedBytes,
    qgramHashes: pack([...qgrams].sort()),
  };
};
