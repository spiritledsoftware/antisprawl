import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  codexAccessToken,
  refreshCodexAccessToken,
  type CodexAuthServices,
  type HttpFetch,
} from "./codex-auth.ts";
import { AppError, appError } from "./errors.ts";
import { embeddingRepresentationVersion } from "./representation.ts";

declare global {
  var ANTISPRAW_LIVE_PROFILE_MATRIX: boolean | undefined;
}

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
  readonly embed: (
    inputs: ReadonlyArray<EmbeddingRequest>,
  ) => Effect.Effect<unknown, AppError, CodexAuthServices>;
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

const OpenAIResponse = Schema.Struct({
  object: Schema.Literal("list"),
  data: Schema.Array(
    Schema.Struct({
      object: Schema.Literal("embedding"),
      index: Schema.Int,
      // Decoded here so runEmbeddingBatch retains the typed non-finite-vector failure.
      // @effect-diagnostics-next-line schemaNumber:off
      embedding: Schema.Array(Schema.Number),
    }),
  ),
  model: Schema.String,
  usage: Schema.Struct({ prompt_tokens: Schema.Finite, total_tokens: Schema.Finite }),
});

const Json = Schema.fromJsonString(Schema.Unknown);

// Native fetch is the accepted provider transport for issue #18.
// @effect-diagnostics-next-line globalFetch:off
const nativeFetch: HttpFetch = (input, init) => fetch(input, init);

const openAIEmbed = Effect.fn("Embedding.openAIEmbed")(function* (
  profile: Profile,
  accessToken: string,
  inputs: ReadonlyArray<EmbeddingRequest>,
  fetcher: HttpFetch,
  refresh?: (rejectedAccessToken: string) => Effect.Effect<string, AppError, CodexAuthServices>,
) {
  const started = performance.now();

  const requestBody = yield* Schema.encodeEffect(Json)({
    input: inputs.map(({ input }) => input),
    model: profile.model,
    dimensions: profile.dimensions,
    encoding_format: "float",
  }).pipe(
    Effect.mapError(() =>
      appError("embedding_request_invalid", "The embedding request could not be encoded."),
    ),
  );

  const send = (token: string) =>
    Effect.tryPromise({
      try: (signal) =>
        fetcher("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: requestBody,
          signal,
        }),
      catch: () =>
        appError("embedding_transport_failed", "The embedding provider could not be reached."),
    });

  let response = yield* send(accessToken);

  if (response.status === 401 && refresh !== undefined) {
    response = yield* send(yield* refresh(accessToken));
  }

  if (response.status === 401) {
    return yield* appError("embedding_authentication_failed", "Embedding authentication failed.");
  }

  if (!response.ok) {
    return yield* appError(
      "embedding_transport_failed",
      "The embedding provider rejected the request.",
    );
  }

  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () =>
      appError("embedding_response_invalid", "The embedding provider returned invalid data."),
  });

  const body = yield* Schema.decodeEffect(Json)(text).pipe(
    Effect.mapError(() =>
      appError("embedding_response_invalid", "The embedding provider returned invalid data."),
    ),
  );

  const decoded = yield* Schema.decodeUnknownEffect(OpenAIResponse)(body).pipe(
    Effect.mapError(() =>
      appError("embedding_response_invalid", "The embedding provider returned invalid data."),
    ),
  );

  if (
    decoded.model !== profile.model ||
    decoded.usage.prompt_tokens < 0 ||
    decoded.usage.total_tokens < decoded.usage.prompt_tokens
  ) {
    return yield* appError(
      "embedding_response_invalid",
      "The embedding provider returned invalid data.",
    );
  }

  if (decoded.data.length !== inputs.length) {
    return yield* appError(
      "embedding_response_count_invalid",
      "The embedding provider returned an unexpected number of vectors.",
    );
  }

  for (const [index, item] of decoded.data.entries()) {
    if (item.index !== index) {
      return yield* appError(
        "embedding_response_order_invalid",
        "The embedding provider returned vectors in an unexpected order.",
      );
    }
  }

  return {
    vectors: decoded.data.map((item, index) => ({
      index: inputs[index]!.index,
      hash: inputs[index]!.hash,
      vector: item.embedding,
    })),
    usage: {
      inputTokens: decoded.usage.prompt_tokens,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
    },
  };
});

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
  configured?: "openai" | "openai-codex",
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  fetcher: HttpFetch = nativeFetch,
): EmbeddingProvider | undefined => {
  if (environment.ANTISPRAW_ACCEPTANCE_EMBEDDINGS !== "deterministic-v1") {
    if (configured === undefined) return undefined;

    const acceptanceDimensions =
      globalThis.ANTISPRAW_LIVE_PROFILE_MATRIX === true
        ? Number(environment.ANTISPRAW_ACCEPTANCE_OPENAI_DIMENSIONS)
        : 384;

    const profile: Profile = {
      provider: configured,
      model: "text-embedding-3-small",
      dimensions: acceptanceDimensions === 1536 ? 1536 : 384,
      language: "typescript",
      representation: embeddingRepresentationVersion,
      detector: 2,
      semanticThreshold,
      calibration: "calibrated",
    };

    return {
      profile,
      deadlineMs: 30_000,
      embed: (inputs) => {
        if (configured === "openai-codex") {
          return codexAccessToken(environment, fetcher).pipe(
            Effect.flatMap((accessToken) =>
              openAIEmbed(profile, accessToken, inputs, fetcher, (rejectedAccessToken) =>
                refreshCodexAccessToken(environment, rejectedAccessToken, fetcher),
              ),
            ),
          );
        }

        const accessToken = environment.OPENAI_API_KEY;

        return accessToken === undefined || accessToken.length === 0
          ? Effect.fail(
              appError("embedding_authentication_failed", "Embedding authentication failed."),
            )
          : openAIEmbed(profile, accessToken, inputs, fetcher);
      },
    };
  }

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
