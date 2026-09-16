import { applicationCosine } from "./embedding.ts";
import type { StructuralRepresentation } from "./representation.ts";

export const detectorVersion = 2;

export const structuralPolicy = {
  version: 1,
  minimumTokens: 20,
  qgramSimilarity: 0.9,
  orderedTokenSimilarity: 0.85,
  maximumOrderedCells: 1_000_000,
} as const;

export interface IndexedSymbol extends StructuralRepresentation {
  readonly path: string;
  readonly language: "typescript";
}

export interface FindingLocation {
  readonly path: string;
  readonly qualifiedName: string;
  readonly range: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
}

export interface Finding {
  readonly id: string;
  readonly type: "probable_duplicate";
  readonly language: "typescript";
  readonly edited: FindingLocation;
  readonly candidate: FindingLocation;
  readonly structuralEvidence: {
    readonly strictHashEqual: boolean;
    readonly normalizedHashEqual: boolean;
    readonly qgramSimilarity: number;
    readonly orderedTokenSimilarity: number;
  };
  readonly semanticEvidence?: {
    readonly cosineSimilarity: number;
  };
  readonly guidance: string;
}

export interface SemanticAnalysis {
  readonly threshold: number;
  readonly vectors: ReadonlyMap<string, Float32Array>;
  readonly candidateHashesByQuery?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface DetectorResult {
  readonly findings: ReadonlyArray<Finding>;
  readonly diagnostics: ReadonlyArray<{
    readonly severity: "warning";
    readonly code: string;
    readonly path?: string;
  }>;
  readonly comparisons: number;
  readonly rescored: number;
}

const identity = (symbol: IndexedSymbol) => `${symbol.path}\0${symbol.qualifiedName}`;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const compareIdentity = (left: IndexedSymbol, right: IndexedSymbol) =>
  compareText(left.path, right.path) || compareText(left.qualifiedName, right.qualifiedName);

const location = (symbol: IndexedSymbol): FindingLocation => ({
  path: symbol.path,
  qualifiedName: symbol.qualifiedName,
  range: {
    start: { line: symbol.startRow + 1, column: symbol.startColumn + 1 },
    end: { line: symbol.endRow + 1, column: symbol.endColumn + 1 },
  },
});

const findingId = (left: IndexedSymbol, right: IndexedSymbol) => {
  const [first, second] = [left, right].sort(compareIdentity);

  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify([
        "probable_duplicate",
        "typescript",
        [first!.path, first!.qualifiedName],
        [second!.path, second!.qualifiedName],
      ]),
    )
    .digest("hex");
};

const hashes = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex").match(/.{64}/g) ?? [];

const jaccard = (left: Uint8Array, right: Uint8Array) => {
  const first = new Set(hashes(left));
  const second = new Set(hashes(right));
  let intersection = 0;

  for (const value of first) {
    if (second.has(value)) intersection += 1;
  }

  const union = first.size + second.size - intersection;

  return union === 0 ? 1 : intersection / union;
};

const orderedSimilarity = (leftBytes: Uint8Array, rightBytes: Uint8Array) => {
  let left = hashes(leftBytes);
  let right = hashes(rightBytes);

  if (left.length > right.length) [left, right] = [right, left];

  if (right.length === 0) return 1;

  let previous = new Uint32Array(left.length + 1);
  let current = new Uint32Array(left.length + 1);

  for (const rightHash of right) {
    for (let column = 1; column <= left.length; column += 1) {
      current[column] =
        left[column - 1] === rightHash
          ? previous[column - 1]! + 1
          : Math.max(previous[column]!, current[column - 1]!);
    }

    [previous, current] = [current, previous];
    current.fill(0);
  }

  return previous[left.length]! / right.length;
};

const roundEvidence = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export const detectProbableDuplicates = (
  edited: ReadonlyArray<IndexedSymbol>,
  current: ReadonlyArray<IndexedSymbol>,
  semantic?: SemanticAnalysis,
): DetectorResult => {
  const eligible = current.filter((symbol) => symbol.tokenCount >= structuralPolicy.minimumTokens);
  const counts = new Map<string, number>();

  for (const symbol of eligible) {
    const key = identity(symbol);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const ambiguous = new Set([...counts].flatMap(([key, count]) => (count > 1 ? [key] : [])));
  const candidates = eligible.filter((symbol) => !ambiguous.has(identity(symbol)));

  const editedIds = new Set(
    edited.flatMap((symbol) =>
      symbol.tokenCount >= structuralPolicy.minimumTokens && !ambiguous.has(identity(symbol))
        ? [identity(symbol)]
        : [],
    ),
  );

  const findings: Array<{
    readonly finding: Finding;
    readonly cosineSimilarity?: number;
    readonly qgramSimilarity: number;
    readonly orderedTokenSimilarity: number;
  }> = [];

  const diagnostics: Array<{
    readonly severity: "warning";
    readonly code: string;
    readonly path?: string;
  }> = [...ambiguous].map((key) => ({
    severity: "warning",
    code: "symbol_identity_ambiguous",
    path: key.slice(0, key.indexOf("\0")),
  }));

  let comparisons = 0;
  let rescored = 0;

  for (const changed of candidates) {
    if (!editedIds.has(identity(changed))) continue;

    for (const candidate of candidates) {
      const candidateIsEdited = editedIds.has(identity(candidate));

      if (
        identity(changed) === identity(candidate) ||
        (candidateIsEdited && compareIdentity(changed, candidate) > 0)
      ) {
        continue;
      }

      if (
        semantic?.candidateHashesByQuery !== undefined &&
        !semantic.candidateHashesByQuery.get(changed.embeddingHash)?.has(candidate.embeddingHash)
      ) {
        continue;
      }

      const id = findingId(changed, candidate);

      comparisons += 1;

      const normalizedHashEqual = changed.normalizedHash === candidate.normalizedHash;
      let qgramSimilarity = 1;
      let tokenOrderSimilarity = 1;

      if (!normalizedHashEqual) {
        qgramSimilarity = jaccard(changed.qgramHashes, candidate.qgramHashes);

        if (qgramSimilarity < structuralPolicy.qgramSimilarity) continue;

        const leftTokens = changed.orderedTokenHashes.byteLength / 32;
        const rightTokens = candidate.orderedTokenHashes.byteLength / 32;

        if (leftTokens * rightTokens > structuralPolicy.maximumOrderedCells) {
          diagnostics.push({
            severity: "warning",
            code: "ordered_comparison_limit",
            path: changed.path,
          });
          continue;
        }

        tokenOrderSimilarity = orderedSimilarity(
          changed.orderedTokenHashes,
          candidate.orderedTokenHashes,
        );

        if (tokenOrderSimilarity < structuralPolicy.orderedTokenSimilarity) continue;
      }

      let cosineSimilarity: number | undefined;

      if (semantic !== undefined) {
        const changedVector = semantic.vectors.get(changed.embeddingHash);
        const candidateVector = semantic.vectors.get(candidate.embeddingHash);

        if (changedVector === undefined || candidateVector === undefined) continue;

        cosineSimilarity = applicationCosine(changedVector, candidateVector);
        rescored += 1;

        if (cosineSimilarity < semantic.threshold) continue;
      }

      const finding: Finding = {
        id,
        type: "probable_duplicate",
        language: "typescript",
        edited: location(changed),
        candidate: location(candidate),
        structuralEvidence: {
          strictHashEqual: changed.strictHash === candidate.strictHash,
          normalizedHashEqual,
          qgramSimilarity: roundEvidence(qgramSimilarity),
          orderedTokenSimilarity: roundEvidence(tokenOrderSimilarity),
        },
        semanticEvidence:
          cosineSimilarity === undefined
            ? undefined
            : { cosineSimilarity: roundEvidence(cosineSimilarity) },
        guidance:
          "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
      };

      findings.push({
        cosineSimilarity,
        qgramSimilarity,
        orderedTokenSimilarity: tokenOrderSimilarity,
        finding,
      });
    }
  }

  return {
    findings: findings
      .sort(
        (left, right) =>
          (right.cosineSimilarity ?? 0) - (left.cosineSimilarity ?? 0) ||
          Number(right.finding.structuralEvidence.strictHashEqual) -
            Number(left.finding.structuralEvidence.strictHashEqual) ||
          Number(right.finding.structuralEvidence.normalizedHashEqual) -
            Number(left.finding.structuralEvidence.normalizedHashEqual) ||
          right.qgramSimilarity - left.qgramSimilarity ||
          right.orderedTokenSimilarity - left.orderedTokenSimilarity ||
          compareText(left.finding.id, right.finding.id),
      )
      .map(({ finding }) => finding),
    diagnostics: [
      ...new Map(
        diagnostics.map((diagnostic) => [
          `${diagnostic.code}\0${diagnostic.path ?? ""}`,
          diagnostic,
        ]),
      ).values(),
    ].sort((left, right) => compareText(left.path ?? "", right.path ?? "")),
    comparisons,
    rescored,
  };
};
