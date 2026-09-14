# Codex OAuth embeddings

**Question:** What source-backed behavior must Antisprawl's experimental Codex OAuth embedding adapter support, and which paths remain unsupported?

**Status:** Resolved for [issue #4](https://github.com/spiritledsoftware/antisprawl/issues/4). This is a research record only; it does not change product code or dependencies.

## Decision

Keep `openai-codex` as an **experimental, personal-development provider** behind the accepted architecture in [`docs/architecture.md`](../architecture.md#experimental-codex-oauth-adapter).

OpenAI documents ChatGPT sign-in and API-key sign-in for Codex, and documents cached credentials. It does **not** document a ChatGPT/Codex OAuth bearer token as a supported credential for the public `/v1/embeddings` API. The authentication guide says that access tokens are for trusted Codex workflows and that general OpenAI API calls should use Platform API keys ([OpenAI authentication](https://developers.openai.com/codex/auth)). Therefore:

- Hindsight's working route is useful empirical evidence, not an OpenAI compatibility guarantee.
- The adapter must be opt-in, clearly labeled experimental, and initially limited to personal development.
- Provider failure must fail open to structural-only detection; it must never make an edit or hook fail closed.
- Keyring-only credentials remain unsupported until a documented bridge exists. Users need file-backed auth (`cli_auth_credentials_store = "file"`) for this slice.

## Evidence hierarchy

1. **OpenAI's public documentation and Codex source** define the supported API and credential behavior.
2. **Hindsight's merged implementation and tests** demonstrate a tested, third-party compatibility path.
3. **Antisprawl's accepted architecture** defines the intentionally narrower adapter and its safety policy.

A third-party implementation cannot upgrade an unsupported OpenAI route into a supported contract.

## Credential discovery and file shape

### Official behavior

OpenAI says that Codex caches credentials in a plaintext `auth.json` or an OS credential store. File storage is under `CODEX_HOME` and defaults to `~/.codex`; `file`, `keyring`, `auto`, and `ephemeral` storage modes are available. The file must be treated like a password because it contains access tokens ([authentication: login caching and credential storage](https://developers.openai.com/codex/auth#login-caching), [Codex config types](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/config/src/types.rs#L108-L121)).

The current Codex source models the file as `AuthDotJson`, with `auth_mode`, `OPENAI_API_KEY`, `tokens`, `last_refresh`, and additional fields ([storage.rs](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/auth/storage.rs#L39-L65)). `tokens` contains an access token, refresh token, parsed ID-token information, and optional account ID; Codex describes the access token as a JWT ([token_data.rs](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/token_data.rs#L10-L25)).

### Adapter contract

The adapter should:

1. Resolve `$CODEX_HOME/auth.json`; if `CODEX_HOME` is unset or empty, use `~/.codex/auth.json`.
2. Require file-backed ChatGPT/Codex auth and a non-empty `tokens.access_token`. Reject API-key mode, keyring-only mode, ephemeral mode, and malformed files with a sanitized diagnostic.
3. Read `tokens.refresh_token` and `tokens.account_id` when present. A missing refresh token permits one-shot use while the access token remains accepted, but cannot support refresh after expiry.
4. Never put credentials in Antisprawl config, logs, findings, reports, or errors. Do not check in or copy `auth.json`.
5. Preserve unknown top-level and token fields during rotation. The native Codex file backend currently writes by truncate/write ([storage.rs](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/auth/storage.rs#L183-L223)); the adapter must strengthen this with atomic replacement.

Hindsight's reference resolver and validation are in [commit 8987fb8](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L72-L228). Its path behavior matches the architecture, but Antisprawl should not inherit Hindsight's larger configuration surface.

## Refresh lifecycle

### Request and response

Codex's canonical refresh flow is:

```text
POST https://auth.openai.com/oauth/token
Content-Type: application/json

{
  "client_id": "<Codex OAuth client id>",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh token>"
}
```

The endpoint, body fields, and response shape are source-backed by [Codex manager.rs](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/auth/manager.rs#L1597-L1721). A successful response must contain `access_token`; `refresh_token` and `id_token` are optional. If the response omits `refresh_token`, keep the existing one. Update in-memory credentials first, then persist the rotation atomically.

### Scheduling and concurrency

- Decode the JWT payload only to schedule refresh. Do not treat an unverified `exp` claim as proof that a token is valid; the provider response remains authoritative.
- Refresh shortly before expiry. Codex's current manager uses a five-minute JWT window and an eight-day `last_refresh` fallback ([manager.rs](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/auth/manager.rs#L189-L200), [#L2959-L2981](https://github.com/openai/codex/blob/e9633d7a0226eac91c7a791dc4f92cf8f25df2ae/codex-rs/login/src/auth/manager.rs#L2959-L2981)). Hindsight's adapter uses a 60-second skew ([codex_auth.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L271-L306)); the exact Antisprawl window should be fixed by acceptance tests rather than treated as a public contract.
- Lock the auth store across concurrent adapter instances and processes. A path-scoped in-process lock plus a POSIX advisory sidecar lock is the tested Hindsight precedent ([codex_auth.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L88-L124)).
- Under the lock, re-read the file and adopt a newer on-disk token set before using an old refresh token. This prevents refresh-token reuse races between processes. The later Hindsight fix also refuses to adopt a merely different but expired disk token on the forced 401 path ([codex_auth.py](https://github.com/vectorize-io/hindsight/blob/325f883505a10b604449a7b187c8ef5b4484af62/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L422-L476)).
- Write a sibling temporary file, flush and `fsync`, set mode `0600`, then `replace` it over `auth.json`. If refresh or persistence fails, leave the existing file untouched and fail open. Hindsight's preservation and atomic-write code is [here](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/providers/codex_auth.py#L312-L354).

### Failure policy

- Treat terminal refresh failures (`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`, and an unusable `invalid_grant`) as permanent. Tell the user to run `codex login` again; do not loop.
- Treat network errors, malformed success bodies, timeouts, and 5xx responses as transient provider failures. Do not modify `auth.json` and allow structural-only fallback.
- Never log request bodies, access tokens, refresh tokens, ID tokens, response bodies that may contain credentials, or token-bearing exception text. Hindsight has an explicit no-token-log regression test ([test_codex_oauth_refresh.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/tests/test_codex_oauth_refresh.py#L352-L370)).

Hindsight's merged work provides the relevant chronology: [#1704](https://github.com/vectorize-io/hindsight/pull/1704) introduced the `openai-codex` embeddings route, [#1712](https://github.com/vectorize-io/hindsight/pull/1712) extracted refresh handling, [#1809](https://github.com/vectorize-io/hindsight/pull/1809) cleaned up the adapter, [#2706](https://github.com/vectorize-io/hindsight/commit/8987fb826746d13c38f883182a52207cd6bc8c76) added auth-file coordination, and [#3804](https://github.com/vectorize-io/hindsight/commit/325f883505a10b604449a7b187c8ef5b4484af62) hardened forced refresh against stale disk adoption. These are compatibility evidence only.

## Embeddings request contract

OpenAI's public embeddings endpoint is `POST https://api.openai.com/v1/embeddings`. Its documented request fields are `input`, `model`, optional `dimensions` (only for `text-embedding-3` and later), optional `encoding_format`, and optional `user`; the normal documented authentication example uses a Platform API key ([embeddings guide](https://developers.openai.com/api/docs/guides/embeddings), [endpoint reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)). The experimental adapter substitutes the file-backed Codex access token as the bearer value, which is precisely the unsupported part.

Required adapter behavior:

- Use the fixed `https://api.openai.com/v1` base URL for this provider; do not send embeddings to Codex's ChatGPT backend URL.
- Implement the Antisprawl `EmbeddingModel` seam with ordered `embedMany` behavior. Split inputs into explicit bounded chunks; do not depend on an SDK's implicit batching.
- Start with `text-embedding-3-small`. Its default vector length is 1536. The accepted architecture requires a 384-dimensional vertical-slice comparison against 1536 on the same fixtures; pass `dimensions: 384` explicitly when testing or selecting that profile.
- Respect the documented limits: each input is at most 8192 tokens, each request has at most 2048 inputs, and the sum of input tokens is at most 300,000. A smaller configured batch limit is expected for hook latency and predictable usage.
- Validate response data before writing vectors: response count equals input count; each index is an integer in the expected range with no duplicates; return vectors in input order; every vector is finite and has exactly the configured dimension. Reject unexpected object/model shapes rather than silently indexing malformed data.
- Validate `usage.prompt_tokens` and `usage.total_tokens` as non-negative numeric metadata and report bounded aggregate usage without retaining raw input or vectors in operational reports. The documented response includes `data[index, object, embedding]`, `model`, and `usage[prompt_tokens,total_tokens]` ([endpoint reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create)).
- On an embeddings `401`, force one credential refresh and retry the same request exactly once. If the retry fails (or refresh is unavailable), return a provider failure and use structural-only behavior; never retry indefinitely. Hindsight's adapter and tests demonstrate this shape ([embeddings.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/embeddings.py#L713-L780), [tests](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/tests/test_codex_oauth_refresh.py#L648-L687)).

Hindsight's OpenAI implementation shows explicit `batch_size`, optional `dimensions`, ordered index sorting, and model dimension defaults ([embeddings.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/embeddings.py#L640-L710)). Its provider factory passes model, batch size, and dimensions for `openai-codex` ([embeddings.py](https://github.com/vectorize-io/hindsight/blob/8987fb826746d13c38f883182a52207cd6bc8c76/hindsight-api-slim/hindsight_api/engine/embeddings.py#L1618-L1627)); the architecture narrows this to Antisprawl's config and Effect adapter seam.

## Source egress and data handling

Selecting this provider sends source-derived embedding input (language, signature, and comment-free symbol body) to `api.openai.com`. This is **Source egress**, not telemetry. The CLI must show provider, model, dimensions, egress status, and estimated input before full indexing; remote indexing requires explicit confirmation (`--yes` for non-interactive use), while `--dry-run` performs no embedding calls. Hooks must not initiate a full or newly billable backfill ([architecture](../architecture.md#experimental-codex-oauth-adapter)).

OpenAI's Platform data-controls page says `/v1/embeddings` is not used for training by default, has abuse-monitoring retention of up to 30 days, stores no application state, and is Zero Data Retention eligible ([data controls](https://developers.openai.com/api/docs/guides/your-data#storage-requirements-and-retention-controls)). That table describes the Platform API contract; it does **not** establish that ChatGPT subscription OAuth tokens are authorized for embeddings or that ChatGPT workspace retention/residency policy is identical. Treat the OAuth route as unverified for production, regulated data, and any assumption about billing or retention.

The index must retain profile/provenance and aggregate usage only; it must not retain raw embedding inputs or vectors in operational reports beyond the index data required by the architecture. Structural-only mode remains available without Source egress.

## Supported versus unsupported

| Area           | Supported by the experimental slice                                                                                                                   | Unsupported or deliberately deferred                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Credentials    | File-backed ChatGPT/Codex auth in `$CODEX_HOME/auth.json`, then `~/.codex/auth.json`; access/refresh/account fields; atomic rotated-token persistence | Keyring-only, ephemeral-only, API-key mode through this provider; arbitrary auth stores                                |
| Refresh        | JWT-expiry scheduling, auth-file locking, disk adoption, OAuth rotation, one forced refresh after embeddings `401`                                    | Treating JWT `exp` as validation; unbounded retries; mutating the file after failed refresh                            |
| Endpoint       | `https://api.openai.com/v1/embeddings` with explicit model/input/dimensions and ordered vectors                                                       | Claiming OpenAI officially supports ChatGPT OAuth at `/v1/embeddings`; using `chatgpt.com/backend-api` for embeddings  |
| Models/profile | `text-embedding-3-small`; compare 384 and 1536 profiles on frozen fixtures                                                                            | Shipping a calibrated threshold/profile before the comparison; assuming dimensions are interchangeable across profiles |
| Operation      | Explicit bounded `embedMany`, response/vector/usage validation, aggregate usage, structural-only fallback                                             | Implicit SDK batching, raw bodies/vectors in reports, remote calls without confirmation                                |
| Audience       | Opt-in personal development experiment                                                                                                                | Production, regulated or sensitive source, and any use that requires an OpenAI support guarantee                       |

## Acceptance checklist for implementation

- [ ] Provider selection is explicit; structural-only remains the default alternative and failure fallback.
- [ ] `$CODEX_HOME` resolution and `~/.codex` fallback are tested without reading a developer's real auth file.
- [ ] File validation rejects wrong auth mode, missing access token, malformed JSON, and keyring-only setups with sanitized diagnostics.
- [ ] Refresh request shape matches Codex source; refresh rotation, omitted refresh token, terminal errors, transient errors, and no-write-on-failure are tested.
- [ ] Concurrent adapter instances/processes produce one refresh per auth file and adopt a sibling's rotated credentials.
- [ ] Atomic replacement preserves unknown fields and uses restrictive permissions; no temporary files or token values leak.
- [ ] Embeddings request uses `/v1/embeddings`, explicit model/input/dimensions, and explicit bounded chunks.
- [ ] Responses validate count, indices, vector dimensions/finite values, model/object shape, and usage metadata; vectors are returned in input order.
- [ ] A `401` causes exactly one forced refresh and one retry; a second `401` fails open.
- [ ] Full indexing displays and confirms Source egress; `--dry-run` makes no remote request.
- [ ] 384- versus 1536-dimensional results are compared on identical fixtures before a profile is shipped; custom/unverified profiles are marked uncalibrated.

## Map gist

**Experimental `openai-codex` can reuse file-backed Codex ChatGPT auth for a carefully guarded embeddings probe, but OpenAI does not guarantee this OAuth-to-`/v1/embeddings` route; ship it only as opt-in personal-development behavior with structural-only fallback.**
