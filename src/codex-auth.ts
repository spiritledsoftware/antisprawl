import { homedir } from "node:os";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { appError, type AppError } from "./errors.ts";

export type HttpFetch = (input: string, init: RequestInit) => Promise<Response>;

export type CodexAuthServices = Crypto.Crypto | FileSystem.FileSystem | Path.Path;

const Json = Schema.fromJsonString(Schema.Unknown);

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);

const AuthTokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const AuthFile = Schema.Struct({
  auth_mode: Schema.Literal("chatgpt"),
  tokens: AuthTokens,
  last_refresh: Schema.optionalKey(Schema.String),
});

const RefreshResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
});

const JwtPayload = Schema.Struct({ exp: Schema.Finite });

interface DecodedAuth {
  readonly text: string;
  readonly raw: typeof UnknownRecord.Type;
  readonly rawTokens: typeof UnknownRecord.Type;
  readonly accessToken: string;
  readonly refreshToken?: string;
}

const authFailure = () =>
  appError("embedding_authentication_failed", "Embedding authentication failed.");

const refreshFailure = () =>
  appError("embedding_refresh_failed", "Embedding authentication could not be refreshed.");

const resolveAuthPath = Effect.fn("CodexAuth.resolvePath")(function* (
  environment: Readonly<Record<string, string | undefined>>,
) {
  const paths = yield* Path.Path;
  const configured = environment.CODEX_HOME?.trim();
  const home = environment.HOME?.trim() || homedir();

  const root =
    configured === undefined || configured === "" ? paths.join(home, ".codex") : configured;

  return paths.join(root, "auth.json");
});

const readAuth = Effect.fn("CodexAuth.read")(function* (path: string, error: AppError) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() => error));

  const unknown = yield* Schema.decodeEffect(Json)(text).pipe(Effect.mapError(() => error));

  const raw = yield* Schema.decodeUnknownEffect(UnknownRecord)(unknown).pipe(
    Effect.mapError(() => error),
  );

  const decoded = yield* Schema.decodeUnknownEffect(AuthFile)(unknown).pipe(
    Effect.mapError(() => error),
  );

  const rawTokens = yield* Schema.decodeUnknownEffect(UnknownRecord)(raw.tokens).pipe(
    Effect.mapError(() => error),
  );

  if (decoded.tokens.access_token.length === 0) return yield* error;

  return {
    text,
    raw,
    rawTokens,
    accessToken: decoded.tokens.access_token,
    refreshToken: decoded.tokens.refresh_token,
  } satisfies DecodedAuth;
});

const jwtExpiry = (token: string): number | undefined => {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );

    const decoded = Schema.decodeUnknownOption(JwtPayload)(payload);

    return Option.isSome(decoded) ? decoded.value.exp : undefined;
  } catch {
    return undefined;
  }
};

const acquireLock = Effect.fn("CodexAuth.acquireLock")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;

  while (true) {
    const acquired = yield* fs
      .writeFileString(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.as(true),
        Effect.catchTag("PlatformError", (error) =>
          Predicate.isTagged(error.reason, "AlreadyExists")
            ? Effect.succeed(false)
            : Effect.fail(refreshFailure()),
        ),
      );

    if (acquired) return;

    yield* Effect.interruptible(Effect.sleep(50));
  }
});

const releaseLock = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    yield* fs.remove(path, { force: true }).pipe(Effect.mapError(() => refreshFailure()));
  });

const encodeAuth = Effect.fn("CodexAuth.encode")(function* (
  auth: DecodedAuth,
  response: typeof RefreshResponse.Type,
) {
  const now = yield* Clock.currentTimeMillis;
  const idToken = response.id_token ?? auth.rawTokens.id_token;

  const tokens = {
    ...auth.rawTokens,
    access_token: response.access_token,
    refresh_token: response.refresh_token ?? auth.refreshToken,
    id_token: idToken,
  };

  return yield* Schema.encodeEffect(Json)({
    ...auth.raw,
    tokens,
    last_refresh: DateTime.make(now).pipe(Option.getOrThrow, DateTime.formatIso),
  }).pipe(Effect.mapError(() => refreshFailure()));
});

const replaceAuth = Effect.fn("CodexAuth.replace")(function* (path: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const suffix = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => refreshFailure()));
  const temporary = paths.join(paths.dirname(path), `.auth.json.${suffix}.tmp`);

  yield* fs.writeFileString(temporary, `${contents}\n`, { flag: "wx", mode: 0o600 }).pipe(
    Effect.andThen(fs.rename(temporary, path)),
    Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    Effect.mapError(() => refreshFailure()),
  );
});

const refreshAccessToken = Effect.fn("CodexAuth.refresh")(function* (
  path: string,
  expectedAccessToken: string,
  fetcher: HttpFetch,
) {
  const lockPath = `${path}.antisprawl.lock`;

  return yield* Effect.acquireUseRelease(
    acquireLock(lockPath),
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const auth = yield* readAuth(path, refreshFailure());

        if (auth.accessToken !== expectedAccessToken) return auth.accessToken;

        if (auth.refreshToken === undefined || auth.refreshToken.length === 0) {
          return yield* refreshFailure();
        }

        const requestBody = yield* Schema.encodeEffect(Json)({
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: auth.refreshToken,
        }).pipe(Effect.mapError(() => refreshFailure()));

        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetcher("https://auth.openai.com/oauth/token", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: requestBody,
              signal,
            }),
          catch: () => refreshFailure(),
        });

        if (!response.ok) return yield* refreshFailure();

        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => refreshFailure(),
        });

        const unknown = yield* Schema.decodeEffect(Json)(text).pipe(
          Effect.mapError(() => refreshFailure()),
        );

        const refreshed = yield* Schema.decodeUnknownEffect(RefreshResponse)(unknown).pipe(
          Effect.mapError(() => refreshFailure()),
        );

        if (refreshed.access_token.length === 0) return yield* refreshFailure();

        const latestText = yield* fs
          .readFileString(path)
          .pipe(Effect.mapError(() => refreshFailure()));

        if (latestText !== auth.text) {
          return (yield* readAuth(path, refreshFailure())).accessToken;
        }

        yield* replaceAuth(path, yield* encodeAuth(auth, refreshed));

        return refreshed.access_token;
      }),
    () => releaseLock(lockPath),
  );
});

export const codexAccessToken = Effect.fn("CodexAuth.accessToken")(function* (
  environment: Readonly<Record<string, string | undefined>>,
  fetcher: HttpFetch,
) {
  const path = yield* resolveAuthPath(environment);
  const auth = yield* readAuth(path, authFailure());
  const expiry = jwtExpiry(auth.accessToken);
  const now = yield* Clock.currentTimeMillis;

  return expiry !== undefined && expiry <= now / 1000 + 5 * 60
    ? yield* refreshAccessToken(path, auth.accessToken, fetcher)
    : auth.accessToken;
});

export const refreshCodexAccessToken = Effect.fn("CodexAuth.refreshRejected")(function* (
  environment: Readonly<Record<string, string | undefined>>,
  rejectedAccessToken: string,
  fetcher: HttpFetch,
) {
  const path = yield* resolveAuthPath(environment);

  return yield* refreshAccessToken(path, rejectedAccessToken, fetcher);
});
