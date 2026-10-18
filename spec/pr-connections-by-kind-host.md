## Summary

A frontend extension can list LLM connection profiles (`ctx.connections.list()`), but not the user's image, TTS, STT, embedding, or Decision profiles. An extension that lets the user pick "which TTS voice" or "which embedding connection" for its own feature has no supported way to fill that picker. This PR adds listing by kind to `ctx.connections`.

- **API**:
  - `ctx.connections.list({ kind })` resolves to credential-free summaries: `id`, `kind`, `name`, `provider`, `model`, `active`, and `voice` (TTS only). `kind` is `llm`, `image`, `tts`, `stt`, `embedding` or `decision`.
  - `ctx.connections.getActive(kind)` resolves to `{ activeProfileId, provider, model }`, the same shape as today's `getActive()`.
  - `list()` and `getActive()` without an argument are unchanged (synchronous, LLM).
- **No credentials**: summaries never contain API keys, endpoint URLs (they can embed `user:pass@`), headers, metadata, or provider parameters.
- **`active`** marks the profile Lumiverse itself uses for that kind when no connection id is given. It reuses the host's own resolution:
  - `llm`: `activeProfileId`; `image`: `activeImageGenConnectionId`
  - `tts`: `resolveTtsConnectionId` (Voice & Speech selection, else the default TTS profile)
  - `stt`: Voice & Speech `sttConnectionId` (the STT connection provider needs an explicit selection)
  - `decision`: the `is_default` profile (as `decisions.service` does without `connection_id`)
  - `embedding`: `primaryProfileId`
- **Data source**: LLM, image, TTS, STT and Decision profiles come from the store (they are loaded at bootstrap). Embedding profiles are not in the store, so `list({ kind: 'embedding' })` reads `GET /api/v1/embeddings/config`. That is why the kind forms return a Promise.
- **Permission**: free, like today's `list()`. Every source is already readable by the session through REST with credentials redacted. The two `frontend-authority-map` rows now say so.
- **Feature detection**: new frontend host capability `connection-kinds-v1: 1`. Older hosts ignore the argument and return LLM profiles, so extensions must check it.
- **Types**: `frontend/package.json` pins `lumiverse-spindle-types` to the companion types commit from https://github.com/prolix-oc/lumiverse-spindle-types/pull/70 (`SpindleConnectionProfileKind`, `SpindleConnectionProfileSummary`, `SpindleActiveConnectionState`, `SPINDLE_CONNECTION_KINDS_HOST_CAPABILITIES`), as #467 did. After the package bump, the pin goes back to a version.
- **Docs**: new `developer-docs/docs/frontend-api/connections.md` (the frontend `ctx.connections` API had no page), plus the index row and nav entry.
- **Not included**:
  - Switching the active profile for kinds other than LLM. Each kind stores its default differently (store field, Voice & Speech setting, `is_default` row, embedding config), so it is not a small change. Extensions can pass a `connectionId` to host APIs instead.
  - A backend (`spindle.connections`) equivalent. The worker already has `imageGen.listConnections` and `decisions.listConnections` with their own permissions, and embeddings are covered by #472.

## Validation

```text
cd frontend && bun run typecheck                    # 0 errors
bun x tsc --noEmit                                  # 0 errors (no backend changes)
cd frontend && bun x eslint <touched files>         # clean
cd frontend && bun test --isolate src/lib/spindle/ctx-domain-api.test.ts src/lib/spindle/frontend-authority-map.test.ts src/lib/spindle/loader.lifecycle.contract.test.ts   # 24 pass, 0 fail
cd frontend && bun test --isolate src/lib/spindle src/lib src/store   # 1636 pass / 1 fail
```

The one failure is `dom decorator service placements > asserts existing frontend data-spindle-mount stamps are present`, a 5 s timeout in the batch run on Windows. It passes alone (15/15) and it does not touch this code.

New test (`ctx-domain-api.test.ts`): every kind lists summaries without `api_key`, `api_url`, `metadata` or `default_parameters`; `active` follows each kind's host rule (TTS falls back to the default profile, STT needs a selection, embedding uses the primary profile); `getActive(kind)` returns nulls when nothing is active; the no-argument forms stay synchronous; no permission is checked; an unknown kind and a disposed extension reject.

## Live test

A scratch Lumiverse from this branch (separate port and data dir) with one or two profiles of every kind. The secrets were marker strings: API keys `*-SECRET`, an LLM URL `https://user:pw@llm.example/v1`, LLM `metadata.custom_headers`, and an embedding URL with `user:pw@`. A throwaway frontend extension with **no permissions** called the API in Chrome:

| Case | Result |
|---|---|
| `ctx.host.capabilities['connection-kinds-v1']` | 1 |
| `list({ kind })` for all six kinds | all profiles, correct `kind`, `name`, `provider`, `model`; TTS rows carry `voice` |
| search of all summaries for `SECRET`, `user:pw`, `custom_headers`, `api_url`, `api_key`, `metadata`, `default_parameters` | none found |
| fresh account | `tts` active = the `is_default` profile; `decision` active = default; `embedding` active = primary; `llm`, `image`, `stt` none |
| after selecting an LLM, an image connection, a Voice & Speech TTS and STT connection, then reload | `getActive` returns those profiles; the TTS active flag moves from the default to the selection |
| `list()` / `getActive()` without an argument | unchanged LLM array / active state |
| `list({ kind: 'music' })` | rejects `CONNECTION_KIND_INVALID: music` |

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass. The new and touched tests pass; the one batch failure is an unrelated timeout that passes alone.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [x] Frontend: `cd frontend && bun run typecheck`; `bun x eslint` on the touched files

## Security-sensitive changes (if applicable)

- New free frontend reads. They expose only id, name, provider, model, TTS voice and the active flag of the session user's own profiles. All of it is already returned by session-authenticated REST routes (`/connections`, `/image-gen-connections`, `/tts-connections`, `/stt-connections`, `/decision-connections`, `/embeddings/config`).
- Keys, URLs, headers, metadata and provider parameters are not projected, so they cannot reach an extension through this API.
- No writes.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.
