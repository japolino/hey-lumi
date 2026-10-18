Adds types for Whistle keywords, word timings and host microphone activity in `ctx.stt`. Companion to the Lumiverse PR (https://github.com/prolix-oc/Lumiverse/pull/474).

- `SpindleSTTTranscribeOptions extends SpindleSTTOptions`: `keywords?: readonly string[]` (names to favour; at most 500, 1-100 characters, no line breaks) and `words?: boolean`. `transcribe()` takes it. Whistle only; other providers ignore `keywords` and omit `words`.
- `SpindleSTTWord = { word, start, end, probability }` (seconds from the start of the supplied audio) and `SpindleSTTTranscript.words?: SpindleSTTWord[]`.
- `SpindleSTTAPI.onHostActivity?(listener: (active: boolean) => void): () => void` and `isHostCapturing?(): boolean`: free; report the chat composer's own microphone session. Optional, because older hosts do not have them.
- New capability `speech-to-text-options-v1: 1` in `SPINDLE_STT_HOST_CAPABILITIES`.

Also adds a consumer type test (`test/api-stt-options-consumer.ts`), updates the capability test, and rebuilds dist. The version is not bumped.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit`, `bun test` (17 pass), `npm run build:consumer`.
