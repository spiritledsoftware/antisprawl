import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AppError, appError } from "./errors.ts";
import { embeddingRepresentationVersion } from "./representation.ts";

export const semanticThreshold = 0.85;

export const embeddingBatchSize = 2;

export interface EmbeddingIdentity {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly language: "typescript";
  readonly representation: number;
}

export interface Profile extends EmbeddingIdentity {
  readonly detector: number;
  readonly semanticThreshold: number;
  readonly calibration: "calibrated" | "uncalibrated";
}

export interface EmbeddingRequest {
  readonly index: number;
  readonly hash: string;
  readonly input: string;
}

const ProviderVector = Schema.Struct({
  index: Schema.Int,
  hash: Schema.String,
  // Non-finite values are decoded so they retain the public typed failure below.
  // @effect-diagnostics-next-line schemaNumber:off
  vector: Schema.Array(Schema.Number),
});

type ProviderVector = typeof ProviderVector.Type;

export interface EmbeddingUsage {
  readonly requests: number;
  readonly inputs: number;
  readonly inputTokens: number;
  readonly durationMs: number;
}

const ProviderResponse = Schema.Struct({
  vectors: Schema.Array(ProviderVector),
  usage: Schema.Struct({
    inputTokens: Schema.Finite,
    durationMs: Schema.Finite,
  }),
});

export interface EmbeddingProvider {
  readonly profile: Profile;
  readonly deadlineMs: number;
  readonly embed: (inputs: ReadonlyArray<EmbeddingRequest>) => Effect.Effect<unknown, AppError>;
}

export interface EmbeddedBatch {
  readonly vectors: ReadonlyArray<{ readonly hash: string; readonly vector: Float32Array }>;
  readonly usage: EmbeddingUsage;
}

export const embeddingIdentityHash = (identity: EmbeddingIdentity): string =>
  Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify([
      identity.provider,
      identity.model,
      identity.dimensions,
      identity.language,
      identity.representation,
    ]),
    "hex",
  );

const deterministicProfile: Profile = {
  provider: "deterministic",
  model: "acceptance-v1",
  dimensions: 2,
  language: "typescript",
  representation: embeddingRepresentationVersion,
  detector: 2,
  semanticThreshold,
  calibration: "calibrated",
};

const deterministicVector = (input: string): ReadonlyArray<number> =>
  /\b(?:Invoice|invoice|dueAt|paidAt)\b/.test(input) ? [0, 1] : [1, 0];

export const configuredEmbeddingProvider = (
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): EmbeddingProvider | undefined => {
  if (environment.ANTISPRAW_ACCEPTANCE_EMBEDDINGS !== "deterministic-v1") return undefined;

  const profile = {
    ...deterministicProfile,
    model: environment.ANTISPRAW_ACCEPTANCE_EMBEDDING_MODEL ?? deterministicProfile.model,
  };

  const configuredFailure = environment.ANTISPRAW_ACCEPTANCE_EMBEDDING_FAILURE;
  const failureBatch = Number(environment.ANTISPRAW_ACCEPTANCE_EMBEDDING_FAILURE_BATCH ?? 1);
  const deadlineMs = Number(environment.ANTISPRAW_ACCEPTANCE_EMBEDDING_DEADLINE_MS ?? 30_000);
  let calls = 0;

  return {
    profile,
    deadlineMs: Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 30_000,
    embed: (inputs) => {
      calls += 1;

      const failure = calls === failureBatch ? configuredFailure : undefined;

      if (failure === "auth") {
        return Effect.fail(
          appError("embedding_authentication_failed", "Embedding authentication failed."),
        );
      }

      if (failure === "transport") {
        return Effect.fail(
          appError("embedding_transport_failed", "The embedding provider could not be reached."),
        );
      }

      if (failure === "timeout") {
        return Effect.sleep("1 minute").pipe(
          Effect.as({ vectors: [], usage: { inputTokens: 0, durationMs: 0 } }),
        );
      }

      let vectors: ReadonlyArray<ProviderVector> = inputs.map((input) => ({
        index: input.index,
        hash: input.hash,
        vector: deterministicVector(input.input),
      }));

      if (failure === "wrong_count") vectors = vectors.slice(0, -1);

      if (failure === "wrong_order") vectors = [...vectors].reverse();

      if (failure === "wrong_index" && vectors[0] !== undefined) {
        vectors = [{ ...vectors[0], index: vectors[0].index + 1 }, ...vectors.slice(1)];
      }

      if (failure === "dimensions" && vectors[0] !== undefined) {
        vectors = [{ ...vectors[0], vector: [1] }, ...vectors.slice(1)];
      }

      if (failure === "nonfinite" && vectors[0] !== undefined) {
        vectors = [{ ...vectors[0], vector: [Number.NaN, 0] }, ...vectors.slice(1)];
      }

      if (failure === "zero" && vectors[0] !== undefined) {
        vectors = [{ ...vectors[0], vector: [0, 0] }, ...vectors.slice(1)];
      }

      return Effect.succeed({
        vectors,
        usage: {
          inputTokens: inputs.reduce((total, input) => total + input.input.split(/\s+/).length, 0),
          durationMs: inputs.length,
        },
      });
    },
  };
};

export const runEmbeddingBatch = Effect.fn("Embedding.runBatch")(function* (
  provider: EmbeddingProvider,
  inputs: ReadonlyArray<EmbeddingRequest>,
) {
  const response = yield* provider.embed(inputs).pipe(
    Effect.timeoutOrElse({
      duration: provider.deadlineMs,
      orElse: () =>
        Effect.fail(appError("embedding_timeout", "The embedding provider exceeded its deadline.")),
    }),
    Effect.flatMap(Schema.decodeUnknownEffect(ProviderResponse)),
    Effect.mapError((error) =>
      Schema.is(AppError)(error)
        ? error
        : appError("embedding_response_invalid", "The embedding provider returned invalid data."),
    ),
  );

  if (response.usage.inputTokens < 0 || response.usage.durationMs < 0) {
    return yield* appError(
      "embedding_response_invalid",
      "The embedding provider returned invalid usage data.",
    );
  }

  if (response.vectors.length !== inputs.length) {
    return yield* appError(
      "embedding_response_count_invalid",
      "The embedding provider returned an unexpected number of vectors.",
    );
  }

  const vectors: Array<{ readonly hash: string; readonly vector: Float32Array }> = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const requested = inputs[index]!;
    const returned = response.vectors[index]!;

    if (returned.index !== requested.index || returned.hash !== requested.hash) {
      return yield* appError(
        "embedding_response_order_invalid",
        "The embedding provider returned vectors in an unexpected order.",
      );
    }

    if (returned.vector.length !== provider.profile.dimensions) {
      return yield* appError(
        "embedding_vector_dimensions_invalid",
        "The embedding provider returned a vector with unexpected dimensions.",
      );
    }

    if (returned.vector.some((value) => !Number.isFinite(value))) {
      return yield* appError(
        "embedding_vector_non_finite",
        "The embedding provider returned a non-finite vector.",
      );
    }

    if (returned.vector.every((value) => value === 0)) {
      return yield* appError(
        "embedding_vector_zero",
        "The embedding provider returned a zero vector.",
      );
    }

    vectors.push({ hash: requested.hash, vector: Float32Array.from(returned.vector) });
  }

  return {
    vectors,
    usage: {
      requests: 1,
      inputs: inputs.length,
      inputTokens: response.usage.inputTokens,
      durationMs: response.usage.durationMs,
    },
  } satisfies EmbeddedBatch;
});

export const encodeVector = (vector: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);

  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));

  return bytes;
};

export const decodeVector = (bytes: Uint8Array, dimensions: number): Float32Array => {
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("Invalid vector byte length.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);

  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }

  return vector;
};

export const applicationCosine = (left: Float32Array, right: Float32Array): number => {
  if (left.length !== right.length) throw new Error("Vector dimensions do not match.");

  let product = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;

    product += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) throw new Error("Cannot compare a zero vector.");

  return product / Math.sqrt(leftMagnitude * rightMagnitude);
};
