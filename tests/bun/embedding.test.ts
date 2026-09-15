import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  applicationCosine,
  configuredEmbeddingProvider,
  decodeVector,
  encodeVector,
  runEmbeddingBatch,
} from "../../src/embedding.ts";

test("vectors use canonical little-endian float32 bytes and application cosine", () => {
  const bytes = encodeVector([1, -2.5]);

  expect([...bytes]).toEqual([0, 0, 128, 63, 0, 0, 32, 192]);
  expect([...decodeVector(bytes, 2)]).toEqual([1, -2.5]);
  expect(
    applicationCosine(new Float32Array([1, 0]), new Float32Array([0.9, 0.4358899])),
  ).toBeCloseTo(0.9, 6);
});

test("the acceptance provider validates and returns deterministic batches", () => {
  const provider = configuredEmbeddingProvider({
    ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
  });

  expect(provider).toBeDefined();

  return Effect.runPromise(
    Effect.gen(function* () {
      const batch = yield* runEmbeddingBatch(provider!, [
        { index: 0, hash: "a".repeat(64), input: "typescript\nfunction jobs status cancelledAt" },
        { index: 1, hash: "b".repeat(64), input: "typescript\nfunction invoice dueAt paidAt" },
      ]);

      expect(batch.vectors.map(({ hash, vector }) => [hash, [...vector]])).toEqual([
        ["a".repeat(64), [1, 0]],
        ["b".repeat(64), [0, 1]],
      ]);
      expect(batch.usage).toEqual({ requests: 1, inputs: 2, inputTokens: 10, durationMs: 2 });
    }),
  );
});
