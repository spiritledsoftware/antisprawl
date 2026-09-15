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

const sha256 = (value: Uint8Array) => Bun.CryptoHasher.hash("sha256", value, "hex");

const tokenDigest = (token: CanonicalToken, normalized: boolean) =>
  Bun.CryptoHasher.hash(
    "sha256",
    `${token.type}\0${token.role}\0${normalized ? token.normalized : token.text}`,
    "hex",
  );

const pack = (hashes: ReadonlyArray<string>) =>
  Buffer.concat(hashes.map((hash) => Buffer.from(hash, "hex")));

export const representSymbol = (symbol: ExtractedSymbol): StructuralRepresentation => {
  // ponytail: SHA-256 per token favors a simple collision-resistant format; benchmark before using narrower hashes.
  const strictTokens = symbol.tokens.map((token) => tokenDigest(token, false));
  const normalizedTokens = symbol.tokens.map((token) => tokenDigest(token, true));
  const qgrams = new Set<string>();

  for (let index = 0; index + 2 < normalizedTokens.length; index += 1) {
    qgrams.add(sha256(pack(normalizedTokens.slice(index, index + 3))));
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
