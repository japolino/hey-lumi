## Summary

A Spindle extension cannot embed text today. It can register an embedding driver (`registerEmbeddingDriver`), but it cannot call the user's embedding connections (Settings > Embeddings). Extensions that match free text against short labels (commands, entity names, descriptions) need this. This PR adds `spindle.embeddings` to the worker runtime. It reuses the existing embeddings service, its secrets and its vector cache.

- **API**:
  - `spindle.embeddings.listConnections({ userId? })` returns the effective user's embedding connections: `id`, `name`, `provider`, `model`, `dimensions`, `enabled`, `is_primary`, `has_api_key`. URLs and API keys are not returned.
  - `spindle.embeddings.embed({ texts, connection_id?, input_type?, userId? }, { signal? })` returns `{ embeddings, connection_id, model, dimensions }`. There is one vector per text, in input order.
- **Default connection**: without `connection_id`, the host uses the user's primary embedding connection. An unknown or disabled connection fails the request.
- **No fallback**: this API never switches to a fallback connection. Host retrieval uses the primary + fallback chain (`requestEmbeddings`). Fallbacks only need the same dimensions, so they can be a different model. An extension that stores label vectors and later embeds a query would then compare vectors from two models without noticing. So each result comes from exactly one connection and reports it. The extension can key its own cache by `connection_id` + `model`.
- **`input_type`**: `"passage"` (default) or `"query"`. It goes through the existing NVIDIA NIM / Cohere input-type handling. Query and passage vectors are cached separately, as in `cachedEmbedTexts`.
- **Cache**: results use the existing `embeddingCache` with the same key as `cachedEmbedTexts`. For the primary connection, extension calls and host retrieval share entries. `getModelFingerprint` now takes the driver config (same fields, `provider: string`). Behaviour does not change.
- **Limits**: 1-256 non-empty texts per call, at most 8192 characters each. The host sends texts in batches of the user's embedding `batch_size` (at most 200), like reindexing does.
  - The use case is a few hundred short labels and one-sentence queries, so that is 1-2 calls.
  - 8192 characters is about 2k tokens. That is under the per-input limit of the providers we support (OpenAI 8191 tokens).
- **Respecting the user's switch**: embedding fails with "Embeddings are disabled for this user" when the user turned embeddings off. In gate mode, non-owners use the owner's connections, as host features do (`resolveEmbeddingUserContext`).
- **Permission**: new `embeddings` permission. It is not privileged, the same as `decisions`.
  - I did not reuse `memories`: it grants full CRUD over the Memory Cortex and chat memory, which is far more than "turn these strings into vectors".
  - I did not reuse `generation`: it is privileged and is about LLM connections.
  - `providers.embedding.register` is the opposite direction (supplying a driver).
- **Worker plumbing**: same pattern as `spindle.decisions`.
  - `WorkerHostEmbeddingsApi` checks the permission, resolves and scopes `userId`, and tracks pending requests for cancellation.
  - An `AbortSignal` sends `embeddings_cancel`. This aborts the provider request, and the worker gets an `AbortError`.
  - Non-committing macro resolution cannot call `embed`.
  - Provider errors go through `sanitizeEmbeddingError` with the connection key.
- **Feature detection**: new host capability `embeddings-v1: 1`.
- **Types**: `package.json` pins `lumiverse-spindle-types` to the companion types commit from https://github.com/prolix-oc/lumiverse-spindle-types/pull/66 (`EmbeddingsWorkerMessage`, `SpindleEmbeddingsAPI`, the permission and the capability), as #467 did. After the package bump, the pin goes back to a version.
- **Docs**: new `developer-docs/docs/backend-api/embeddings.md`, plus rows in the backend API index, the permissions page and the nav.
- **Not included**:
  - Image input. No built-in embedding provider path can send images: OpenAI-compatible bodies send `input: string[]`, and Vertex sends `parts: [{ text }]` (`embeddings.service.ts` around lines 2256 and 2404). Multimodal embedding servers (for example EmbeddingGemma behind llama.cpp/vLLM) each use their own non-standard request shape.
  - A REST endpoint.
  - A frontend `ctx` API.
  - Similarity search helpers.

## Validation

```text
bun x tsc --noEmit                                  # 0 errors
bun test src/spindle/worker-host-embeddings-api.test.ts src/spindle/worker-runtime-embeddings.test.ts src/spindle/worker-runtime-decisions.test.ts src/services/embeddings.service.connection-profiles.test.ts src/services/embedding-cache.test.ts   # 39 pass, 0 fail
bun test src/spindle src/services/embedding* src/services/embeddings* src/services/chat-chunk-embedding.test.ts src/routes/embeddings.routes*.test.ts src/services/decision*.test.ts   # 422 pass / 4 fail
```

The 4 failures (`extension-build` published bundles x2, `spawn-async` early signal, `worker-host-files-api` ZIP32) fail the same way on staging 2a8d9461 on the same Windows machine.

New tests:
- `worker-host-embeddings-api.test.ts`:
  - the primary connection is used by default and reported; batches follow `batch_size`
  - no fallback when the primary fails
  - an explicit connection is used
  - the cache is shared with `cachedEmbedTexts`, and query/passage entries are separate
  - input limits, unknown/disabled connection and disabled embeddings fail before any provider call
  - the key is redacted from provider errors
  - `listConnections` returns no URLs or secrets
  - permission and account scope are checked
  - cancellation returns `AbortError`
- `worker-runtime-embeddings.test.ts`: the namespace, `userId` forwarding, pre-abort and in-flight cancel, the macro guard, and the capability, over both worker and process transports.

## Live test

I ran a scratch Lumiverse from this branch (separate port and data dir) against a local fake OpenAI-compatible `/v1/embeddings` server. It returns deterministic bag-of-words vectors and logs each request. The setup had two embedding connections, "Fake A" (`fake-a`, 32 dims, primary) and "Fake B" (`fake-b`, 16 dims). A throwaway operator extension declared `embeddings` and called the worker API:

| Case | Result |
|---|---|
| `spindle.host.capabilities["embeddings-v1"]` | 1 |
| `listConnections` | both connections, `is_primary` on Fake A, `has_api_key: true`, no URL or key |
| `embed` 4 labels, no `connection_id` | Fake A, `fake-a`, 32 dims, 4 vectors, 1 provider request |
| query "please open my world books" (`input_type: "query"`) ranked against the labels | "Open world books" 0.944, next best 0.522 |
| the same 4 labels again | served from cache, no provider request |
| `connection_id` = Fake B | `fake-b`, 16 dims, sent with Fake B's key |
| 5 texts with `batch_size` 2 | 3 provider requests (2 + 2 + 1) |
| 257 texts / empty text / unknown connection | "At most 256 texts per request" / "Each text must be a non-empty string" / "Embedding connection not found", no provider request |
| provider 500 that echoes the Authorization header | "Embedding request failed (500): upstream says no for key Bearer [redacted]" |
| no `userId` (operator extension) | "userId is required for operator-scoped extensions" |
| abort after 300 ms on a 3 s provider call | `AbortError` "Embeddings request cancelled" after 302 ms |
| embeddings turned off in settings | "Embeddings are disabled for this user"; `listConnections` still works |
| `embeddings` revoked while the worker runs | "PERMISSION_DENIED: embeddings — Embeddings permission not granted"; works again after re-grant |

The API keys do not appear in the server log. Non-privileged permissions are granted again when an extension restarts (`syncPermissionGrants`), the same as `decisions`. So I tested revocation on the running worker.

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass. The new and touched tests pass; the 4 failures in the wider run also fail on staging.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [ ] Frontend: no frontend changes

## Security-sensitive changes (if applicable)

- New gated permission `embeddings` (not privileged, like `decisions`). The extension supplies text. The host sends it only to embedding connections that the user configured, with the user's stored key. Extensions never supply endpoints or credentials and never receive URLs or keys.
- `userId` is resolved and scoped the same way as `spindle.decisions` (`resolveEffectiveUserId` + `enforceScopedUser`).
- Provider error messages are sanitized with the connection key and `Bearer` redaction.
- Input is capped at 256 texts x 8192 characters per call.
- The vector cache is keyed by model fingerprint + text, not by user. This is the same as host retrieval: equal text on the same model gives the same vector.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.
