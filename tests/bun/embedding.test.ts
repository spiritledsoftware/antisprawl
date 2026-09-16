import * as BunServices from "@effect/platform-bun/BunServices";
import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  applicationCosine,
  configuredEmbeddingProvider,
  decodeVector,
  encodeVector,
  runEmbeddingBatch,
} from "../../src/embedding.ts";

const Json = Schema.fromJsonString(Schema.Unknown);

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("vectors use canonical little-endian float32 bytes and application cosine", () => {
  const bytes = encodeVector([1, -2.5]);

  expect([...bytes]).toEqual([0, 0, 128, 63, 0, 0, 32, 192]);
  expect([...decodeVector(bytes, 2)]).toEqual([1, -2.5]);
  expect(
    applicationCosine(new Float32Array([1, 0]), new Float32Array([0.9, 0.4358899])),
  ).toBeCloseTo(0.9, 6);
});

test("the OpenAI provider authenticates, maps vectors, and records usage", () => {
  let request:
    | {
        readonly url: string;
        readonly authorization: string | null;
        readonly body: RequestInit["body"];
      }
    | undefined;

  const first = Array.from({ length: 384 }, () => 0);
  const second = Array.from({ length: 384 }, () => 0);

  first[0] = 1;
  second[1] = 1;

  const fetcher = (input: string, init: RequestInit) => {
    request = {
      url: input,
      authorization: new Headers(init.headers).get("authorization"),
      body: init.body,
    };

    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { object: "embedding", index: 0, embedding: first },
          { object: "embedding", index: 1, embedding: second },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    );
  };

  const provider = configuredEmbeddingProvider(
    "openai",
    {
      OPENAI_API_KEY: "test-key",
      ANTISPRAW_ACCEPTANCE_OPENAI_DIMENSIONS: "1536",
    },
    fetcher,
  );

  return run(
    Effect.gen(function* () {
      const batch = yield* runEmbeddingBatch(provider!, [
        { index: 0, hash: "a".repeat(64), input: "first" },
        { index: 1, hash: "b".repeat(64), input: "second" },
      ]);

      if (request === undefined) throw new Error("Expected an OpenAI request.");

      const requestBody = yield* Schema.decodeUnknownEffect(Schema.String)(request.body).pipe(
        Effect.flatMap(Schema.decodeEffect(Json)),
      );

      expect({ ...request, body: requestBody }).toEqual({
        url: "https://api.openai.com/v1/embeddings",
        authorization: "Bearer test-key",
        body: {
          input: ["first", "second"],
          model: "text-embedding-3-small",
          dimensions: 384,
          encoding_format: "float",
        },
      });
      expect(batch.vectors.map(({ vector }) => Array.from(vector.slice(0, 2)))).toEqual([
        [1, 0],
        [0, 1],
      ]);
      expect(batch.usage).toMatchObject({ requests: 1, inputs: 2, inputTokens: 7 });
    }),
  );
});

test("the OpenAI provider rejects out-of-order response indices", () => {
  const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

  const fetcher = () =>
    Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { object: "embedding", index: 1, embedding: vector },
          { object: "embedding", index: 0, embedding: vector },
        ],
        model: "text-embedding-3-small",
        usage: { prompt_tokens: 7, total_tokens: 7 },
      }),
    );

  const provider = configuredEmbeddingProvider("openai", { OPENAI_API_KEY: "test-key" }, fetcher);

  return run(
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runEmbeddingBatch(provider!, [
          { index: 0, hash: "a".repeat(64), input: "first" },
          { index: 1, hash: "b".repeat(64), input: "second" },
        ]),
      );

      expect(error.code).toBe("embedding_response_order_invalid");
    }),
  );
});

test("the Codex provider refreshes after 401 without losing auth fields", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-codex-auth-" });
        const authPath = paths.join(root, "auth.json");
        const jwt = `header.${Buffer.from('{"exp":4102444800}').toString("base64url")}.signature`;
        const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
        let embeddingCalls = 0;

        yield* fs.writeFileString(
          authPath,
          `{"auth_mode":"chatgpt","tokens":{"access_token":"old-access","refresh_token":"old-refresh","id_token":"${jwt}","account_id":"account","preserve":"token-field"},"last_refresh":"2026-01-01T00:00:00.000Z","preserve":"top-field"}\n`,
        );

        const fetcher = (input: string, init: RequestInit) => {
          if (input === "https://auth.openai.com/oauth/token") {
            return Promise.resolve(
              Response.json({ access_token: "new-access", refresh_token: "new-refresh" }),
            );
          }

          embeddingCalls += 1;

          if (new Headers(init.headers).get("authorization") === "Bearer old-access") {
            return Promise.resolve(new Response(null, { status: 401 }));
          }

          return Promise.resolve(
            Response.json({
              object: "list",
              data: [{ object: "embedding", index: 0, embedding: vector }],
              model: "text-embedding-3-small",
              usage: { prompt_tokens: 3, total_tokens: 3 },
            }),
          );
        };

        const provider = configuredEmbeddingProvider("openai-codex", { CODEX_HOME: root }, fetcher);

        const batch = yield* runEmbeddingBatch(provider!, [
          { index: 0, hash: "a".repeat(64), input: "typescript function example" },
        ]);

        const saved = yield* fs
          .readFileString(authPath)
          .pipe(Effect.flatMap(Schema.decodeEffect(Json)));

        expect(embeddingCalls).toBe(2);
        expect(batch.usage.inputTokens).toBe(3);
        expect(saved).toMatchObject({
          auth_mode: "chatgpt",
          preserve: "top-field",
          tokens: {
            access_token: "new-access",
            refresh_token: "new-refresh",
            account_id: "account",
            preserve: "token-field",
          },
        });
      }),
    ),
  ));

test("concurrent Codex batches share one guarded refresh", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-codex-auth-" });
        const authPath = paths.join(root, "auth.json");
        const jwt = `header.${Buffer.from('{"exp":0}').toString("base64url")}.signature`;
        const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
        let refreshes = 0;

        yield* fs.writeFileString(
          authPath,
          `{"auth_mode":"chatgpt","tokens":{"access_token":"${jwt}","refresh_token":"refresh","id_token":"${jwt}"}}\n`,
        );

        const fetcher = (input: string) => {
          if (input === "https://auth.openai.com/oauth/token") {
            refreshes += 1;

            return Bun.sleep(20).then(() => Response.json({ access_token: "new-access" }));
          }

          return Promise.resolve(
            Response.json({
              object: "list",
              data: [{ object: "embedding", index: 0, embedding: vector }],
              model: "text-embedding-3-small",
              usage: { prompt_tokens: 3, total_tokens: 3 },
            }),
          );
        };

        const provider = configuredEmbeddingProvider("openai-codex", { CODEX_HOME: root }, fetcher);
        const request = [{ index: 0, hash: "a".repeat(64), input: "typescript function example" }];

        yield* Effect.all(
          [runEmbeddingBatch(provider!, request), runEmbeddingBatch(provider!, request)],
          { concurrency: "unbounded" },
        );

        expect(refreshes).toBe(1);
      }),
    ),
  ));

test("Codex refresh adopts credentials rotated by another process", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-codex-auth-" });
        const authPath = paths.join(root, "auth.json");
        const jwt = `header.${Buffer.from('{"exp":4102444800}').toString("base64url")}.signature`;
        const initial = `{"auth_mode":"chatgpt","tokens":{"access_token":"old-access","refresh_token":"old-refresh","id_token":"${jwt}"}}\n`;
        const rotated = `{"auth_mode":"chatgpt","tokens":{"access_token":"codex-access","refresh_token":"codex-refresh","id_token":"${jwt}"},"rotation":"codex"}\n`;
        const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

        yield* fs.writeFileString(authPath, initial);

        const fetcher = (input: string, init: RequestInit) => {
          if (input === "https://auth.openai.com/oauth/token") {
            return Bun.write(authPath, rotated).then(() =>
              Response.json({ access_token: "antisprawl-access" }),
            );
          }

          const authorization = new Headers(init.headers).get("authorization");

          return Promise.resolve(
            authorization === "Bearer codex-access"
              ? Response.json({
                  object: "list",
                  data: [{ object: "embedding", index: 0, embedding: vector }],
                  model: "text-embedding-3-small",
                  usage: { prompt_tokens: 3, total_tokens: 3 },
                })
              : new Response(null, { status: 401 }),
          );
        };

        const provider = configuredEmbeddingProvider("openai-codex", { CODEX_HOME: root }, fetcher);

        yield* runEmbeddingBatch(provider!, [
          { index: 0, hash: "a".repeat(64), input: "typescript function example" },
        ]);

        expect(yield* fs.readFileString(authPath)).toBe(rotated);
      }),
    ),
  ));

test("failed Codex refresh preserves the auth file and sanitizes the error", () =>
  run(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "antisprawl-codex-auth-" });
        const authPath = paths.join(root, "auth.json");
        const jwt = `header.${Buffer.from('{"exp":0}').toString("base64url")}.signature`;
        const original = `{"auth_mode":"chatgpt","tokens":{"access_token":"${jwt}","refresh_token":"secret-refresh","id_token":"${jwt}"},"preserve":"unchanged"}\n`;

        yield* fs.writeFileString(authPath, original);

        const provider = configuredEmbeddingProvider("openai-codex", { CODEX_HOME: root }, () =>
          Promise.resolve(
            Response.json(
              { error: { code: "refresh_token_expired", token: "secret-refresh" } },
              { status: 400 },
            ),
          ),
        );

        const error = yield* Effect.flip(
          runEmbeddingBatch(provider!, [
            { index: 0, hash: "a".repeat(64), input: "typescript function example" },
          ]),
        );

        expect(error).toMatchObject({ code: "embedding_refresh_failed" });
        expect(error.message).not.toContain("secret");
        expect(yield* fs.readFileString(authPath)).toBe(original);
      }),
    ),
  ));

test("the acceptance provider validates and returns deterministic batches", () => {
  const provider = configuredEmbeddingProvider(undefined, {
    ANTISPRAW_ACCEPTANCE_EMBEDDINGS: "deterministic-v1",
  });

  expect(provider).toBeDefined();

  return run(
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
