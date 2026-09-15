import { expect, test } from "bun:test";
import { detectProbableDuplicates, type IndexedSymbol } from "../../src/detector.ts";

const pack = (...values: number[]) =>
  Uint8Array.from(values.flatMap((value) => Array<number>(32).fill(value)));

const symbol = (path: string, qualifiedName: string, strictHash: string): IndexedSymbol => ({
  path,
  language: "typescript",
  key: `${qualifiedName}\0function\u00000:1`,
  qualifiedName,
  kind: "function",
  startByte: 0,
  endByte: 1,
  startRow: 0,
  startColumn: 0,
  endRow: 0,
  endColumn: 1,
  tokenCount: 20,
  strictHash,
  normalizedHash: "same-normalized",
  orderedTokenHashes: pack(1, 2, 3),
  qgramHashes: pack(4),
  embeddingHash: "03".repeat(32),
});

const withFingerprints = (
  base: IndexedSymbol,
  ordered: ReadonlyArray<number>,
  qgrams: ReadonlyArray<number>,
): IndexedSymbol => ({
  ...base,
  normalizedHash: `${base.normalizedHash}-${base.qualifiedName}`,
  orderedTokenHashes: pack(...ordered),
  qgramHashes: pack(...qgrams),
});

test("role-aware normalized equality yields one stable canonical Finding", () => {
  const alpha = symbol("src/a.ts", "alpha", "strict-a");
  const beta = symbol("src/b.ts", "beta", "strict-b");

  const result = detectProbableDuplicates([beta, alpha], [alpha, beta]);

  expect(result.diagnostics).toEqual([]);
  expect(result.comparisons).toBe(1);
  expect(result.findings).toEqual([
    {
      id: "1103922123772358af9cf39e2d058f0238bbc91091fb7abcb758d2f429527089",
      type: "probable_duplicate",
      language: "typescript",
      edited: {
        path: "src/a.ts",
        qualifiedName: "alpha",
        range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
      },
      candidate: {
        path: "src/b.ts",
        qualifiedName: "beta",
        range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 2 },
        },
      },
      structuralEvidence: {
        strictHashEqual: false,
        normalizedHashEqual: true,
        qgramSimilarity: 1,
        orderedTokenSimilarity: 1,
      },
      guidance:
        "Inspect whether the Edited symbol can reuse the Candidate symbol before keeping both.",
    },
  ]);
});

test("near matches require both frozen Structural thresholds", () => {
  const edited = withFingerprints(
    symbol("src/edit.ts", "edited", "strict-edited"),
    Array.from({ length: 20 }, (_, index) => index + 1),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  const passing = withFingerprints(
    symbol("src/pass.ts", "passing", "strict-pass"),
    [...Array.from({ length: 19 }, (_, index) => index + 1), 21],
    [...Array.from({ length: 19 }, (_, index) => index + 1), 21],
  );

  const rejected = withFingerprints(
    symbol("src/reject.ts", "rejected", "strict-reject"),
    [...Array.from({ length: 18 }, (_, index) => index + 1), 21, 22],
    [...Array.from({ length: 18 }, (_, index) => index + 1), 21, 22],
  );

  const result = detectProbableDuplicates([edited], [edited, passing, rejected]);

  expect(result.comparisons).toBe(2);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]?.candidate.qualifiedName).toBe("passing");
  expect(result.findings[0]?.structuralEvidence).toEqual({
    strictHashEqual: false,
    normalizedHashEqual: false,
    qgramSimilarity: 0.904762,
    orderedTokenSimilarity: 0.95,
  });
});

test("Findings rank strict, normalized, then near matches without a result limit", () => {
  const ordered = Array.from({ length: 20 }, (_, index) => index + 1);
  const edited = withFingerprints(symbol("src/edit.ts", "edited", "strict"), ordered, ordered);

  const strict = {
    ...edited,
    path: "src/strict.ts",
    key: "strict",
    qualifiedName: "strict",
  };

  const normalized = {
    ...edited,
    path: "src/normalized.ts",
    key: "normalized",
    qualifiedName: "normalized",
    strictHash: "different",
  };

  const near = withFingerprints(
    symbol("src/near.ts", "near", "near"),
    [...ordered.slice(0, 19), 21],
    [...ordered.slice(0, 19), 21],
  );

  const result = detectProbableDuplicates([edited], [edited, near, normalized, strict]);

  expect(result.findings.map(({ candidate }) => candidate.qualifiedName)).toEqual([
    "strict",
    "normalized",
    "near",
  ]);
});

test("Semantic analysis requires the cosine gate and publishes its evidence", () => {
  const edited = { ...symbol("src/edit.ts", "edited", "edited"), embeddingHash: "11".repeat(32) };

  const passing = {
    ...symbol("src/pass.ts", "passing", "passing"),
    embeddingHash: "22".repeat(32),
  };

  const rejected = {
    ...symbol("src/reject.ts", "rejected", "rejected"),
    embeddingHash: "33".repeat(32),
  };

  const result = detectProbableDuplicates([edited], [edited, passing, rejected], {
    threshold: 0.85,
    vectors: new Map([
      [edited.embeddingHash, new Float32Array([1, 0])],
      [passing.embeddingHash, new Float32Array([0.9, 0.4358899])],
      [rejected.embeddingHash, new Float32Array([0, 1])],
    ]),
  });

  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({
    candidate: { qualifiedName: "passing" },
    semanticEvidence: { cosineSimilarity: 0.9 },
  });
});

test("Semantic thresholds use full precision before public rounding and include the boundary", () => {
  const edited = { ...symbol("src/edit.ts", "edited", "edited"), embeddingHash: "41".repeat(32) };

  const boundary = {
    ...symbol("src/boundary.ts", "boundary", "boundary"),
    embeddingHash: "42".repeat(32),
  };

  const roundedOnly = {
    ...symbol("src/rounded.ts", "rounded", "rounded"),
    embeddingHash: "43".repeat(32),
  };

  const unit = (cosine: number) => new Float32Array([cosine, Math.sqrt(1 - cosine * cosine)]);

  const result = detectProbableDuplicates([edited], [edited, boundary, roundedOnly], {
    threshold: 0.85,
    vectors: new Map([
      [edited.embeddingHash, new Float32Array([1, 0])],
      [boundary.embeddingHash, unit(0.85)],
      [roundedOnly.embeddingHash, unit(0.8499999)],
    ]),
  });

  expect(result.findings).toHaveLength(1);
  expect(result.findings[0]).toMatchObject({
    candidate: { qualifiedName: "boundary" },
    semanticEvidence: { cosineSimilarity: 0.85 },
  });
});

test("Semantic candidate retrieval limits application rescoring", () => {
  const edited = { ...symbol("src/edit.ts", "edited", "edited"), embeddingHash: "51".repeat(32) };

  const candidate = {
    ...symbol("src/candidate.ts", "candidate", "candidate"),
    embeddingHash: "52".repeat(32),
  };

  const result = detectProbableDuplicates([edited], [edited, candidate], {
    threshold: 0.85,
    vectors: new Map([
      [edited.embeddingHash, new Float32Array([1, 0])],
      [candidate.embeddingHash, new Float32Array([1, 0])],
    ]),
    candidateHashesByQuery: new Map([[edited.embeddingHash, new Set([edited.embeddingHash])]]),
  });

  expect(result.comparisons).toBe(0);
  expect(result.findings).toEqual([]);
});

test("Meaningful-size and ambiguous Symbols are excluded", () => {
  const tiny = { ...symbol("src/tiny.ts", "tiny", "tiny"), tokenCount: 19 };
  const first = symbol("src/same.ts", "duplicate", "first");
  const second = { ...symbol("src/same.ts", "duplicate", "second"), key: "second" };

  const result = detectProbableDuplicates([tiny, first], [tiny, first, second]);

  expect(result.comparisons).toBe(0);
  expect(result.findings).toEqual([]);
  expect(result.diagnostics).toEqual([
    { severity: "warning", code: "symbol_identity_ambiguous", path: "src/same.ts" },
  ]);
});

test("oversized non-identical ordered comparisons warn and stop", () => {
  const long = Array.from({ length: 1001 }, (_, index) => (index % 250) + 1);

  const edited = withFingerprints(
    symbol("src/edit.ts", "edited", "edited"),
    long,
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  const candidate = withFingerprints(
    symbol("src/candidate.ts", "candidate", "candidate"),
    [...long.slice(1), 251],
    Array.from({ length: 20 }, (_, index) => index + 1),
  );

  const result = detectProbableDuplicates([edited], [edited, candidate]);

  expect(result.findings).toEqual([]);
  expect(result.diagnostics).toEqual([
    { severity: "warning", code: "ordered_comparison_limit", path: "src/edit.ts" },
  ]);
});
