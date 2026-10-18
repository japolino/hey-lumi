Adds types for listing connection profiles of every kind in the frontend. Companion to the Lumiverse PR (https://github.com/prolix-oc/Lumiverse/pull/477).

- `SpindleFrontendConnectionsAPI.list(options: { kind })` overload resolves to `SpindleConnectionProfileSummary[]`: `id`, `kind`, `name`, `provider`, `model`, `active`, and `voice` (TTS only). No keys, URLs, headers, metadata or parameters.
- `SpindleConnectionProfileKind` = `"llm" | "image" | "tts" | "stt" | "embedding" | "decision"`. It is a new type: the existing `SpindleConnectionKind` is the set of kinds the shared pickers can bind to (`llm`, `image`, `tts`, `embedding`), so widening it would change that API.
- Optional `getActive` with both host forms: `()` for the active LLM profile (synchronous, which the host already has) and `(kind)` resolving to `SpindleActiveConnectionState` (`activeProfileId`, `provider`, `model`).
- New frontend host capability `SPINDLE_CONNECTION_KINDS_HOST_CAPABILITIES` = `{ "connection-kinds-v1": 1 }`. It is separate from `SPINDLE_HOST_CAPABILITIES` because the backend worker does not have this API (same as speech-to-text and client info).

Also adds a consumer type test (`test/connection-kinds-consumer.ts`), a capability test, and rebuilds dist. The version is not bumped.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit`, `bun test` (18 pass), `npm run build:consumer`.
