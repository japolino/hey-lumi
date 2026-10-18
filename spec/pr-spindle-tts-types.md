Adds types for host-managed text-to-speech playback in the frontend (`ctx.tts`). Companion to the Lumiverse PR (https://github.com/prolix-oc/Lumiverse/pull/478).

- New `src/text-to-speech.ts`:
  - `SpindleTTSAPI`: `speak(input, options?)`, `stop()`, `isSpeaking()`, `subscribe(listener)`.
  - `SpindleTTSSpeakInput` = `{ text }` or `{ messageId }`; `SpindleTTSSpeakOptions` = `{ connectionId? }` (text only).
  - `SPINDLE_TTS_HOST_CAPABILITIES` = `{ "text-to-speech-v1": 1 }`, frontend-only like `SPINDLE_STT_HOST_CAPABILITIES`.
- `SpindleFrontendContext.tts?: SpindleTTSAPI`, optional for older hosts.
- The doc comments state the permissions: `speak` and `stop` need `media`; `isSpeaking` and `subscribe` are free.

Also adds a consumer type test (`test/tts-consumer.ts`), a capability test, and rebuilds dist. The version is not bumped.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit`, `bun test` (18 pass), `npm run build:consumer`.
