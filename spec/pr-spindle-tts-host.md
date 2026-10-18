## Summary

Extensions cannot use the host's text-to-speech. They can register a TTS provider, but they cannot speak through the user's TTS connections, and they cannot tell when Lumiverse itself is speaking. The second part matters for voice extensions: an extension that keeps the microphone open must pause while chat TTS plays, or it transcribes Lumiverse's own voice. The host sends no event for that today. Saved message audio plays through an `<audio>` element in `MessageAudioPlayer`, and the in-memory engine (`ttsAudio.ts`) has only one-slot callbacks that nothing outside it can use.

This PR adds `ctx.tts` for frontend extensions, modelled on `ctx.stt`.

- **API**:
  - `speak({ text }, { connectionId? })`: speaks the text as given, with the connection's default voice, the user's TTS speed and volume. `connectionId` defaults to the user's TTS connection (`resolveTtsConnectionId`). Nothing is saved.
  - `speak({ messageId })`: plays a message of the active chat like its Play button. If the message has saved audio for its current swipe, that file is replayed through the engine (no provider call). Otherwise it runs `startMessageTtsPlayback` (per-character voices, narration rules), which saves the audio to the message, as the Play button does.
  - `stop()`: stops all host TTS playback, the engine and any playing saved-message `<audio>` element. This includes chat auto-play.
  - `isSpeaking()` and `subscribe(listener)`: host TTS playback state, `true` while the engine plays (from the start of synthesis) or a saved-message `<audio>` element plays. The listener gets the new boolean on each change, whoever started the playback: the user's Play buttons, chat auto-play, the autoplay-policy engine fallback, or an extension.
- **`speak()` promise**: it first stops current host TTS playback. It resolves when this playback ends, or when it is stopped or replaced. It rejects when it cannot start (`TTS_INPUT_INVALID`, `TTS_UNAVAILABLE:disabled`, `TTS_UNAVAILABLE:connectionRequired`, `TTS_CONNECTION_NOT_FOUND`, `TTS_MESSAGE_NOT_FOUND`, `TTS_NOTHING_TO_SPEAK`) or when synthesis fails (the provider error). After a stop, the rest of the synthesis is aborted.
- **The user's switch**: `speak()` fails with `TTS_UNAVAILABLE:disabled` while Text-to-Speech is off in Voice & Speech, like the host's own playback.
- **Permission**: `speak` and `stop` need `media`, like `ctx.stt`. `isSpeaking` and `subscribe` are free: whether TTS plays is already visible in the shared DOM (Stop buttons, players), and no text or audio crosses. Rows added to `frontend-authority-map`.
- **Cleanup**: unload and `media` revocation stop playback that the extension started. Playback started by the user or auto-play keeps going. Unload removes the extension's listeners.
- **Host changes outside Spindle** (small):
  - `ttsAudio.ts`: a multi-listener playback notification (fired on engine start, end and stop), `getPlaybackSession()`, and tracking of saved-message `<audio>` elements (`trackTTSAudioElement`, `isTTSPlaybackActive`, `stopAllTTSPlayback`). Existing behaviour does not change.
  - `MessageAudioPlayer.tsx`: registers its `<audio>` element with that tracker (3 lines).
  - `ttsMessagePlayback.ts`: `startTextTtsPlayback` (text through `synthesizeTtsSegments`, buffered or streamed, with an abort signal) and `playSavedMessageAudio` (the same engine replay as `MessageAudioPlayer`'s autoplay fallback).
- **Feature detection**: new frontend host capability `text-to-speech-v1: 1`.
- **Types**: `frontend/package.json` pins `lumiverse-spindle-types` to the companion types commit from https://github.com/prolix-oc/lumiverse-spindle-types/pull/71 (`SpindleTTSAPI`, `SpindleTTSSpeakInput`, `SpindleTTSSpeakOptions`, `SPINDLE_TTS_HOST_CAPABILITIES`, `ctx.tts`), as #467 did. After the package bump, the pin goes back to a version.
- **Docs**: new `developer-docs/docs/frontend-api/text-to-speech.md`, plus the index row, nav entry, and the `media` line in `user-docs/docs/extensions/index.md`.
- **Not included**: choosing a voice other than the connection's default, pause/resume, and a backend (worker) API.

## Validation

```text
cd frontend && bun run typecheck                    # 0 errors
bun x tsc --noEmit                                  # 0 errors (no backend changes)
cd frontend && bun x eslint <touched files>         # clean
cd frontend && bun test --isolate src/lib/spindle/tts-api.test.ts src/lib/ttsAudio.playback-state.test.ts src/lib/spindle/frontend-authority-map.test.ts src/lib/spindle/frontend-context.test.ts src/hooks/useMessagePlayback.test.tsx src/components/settings/VoiceSettings.provider-registry.test.tsx   # all pass
cd frontend && bun test --isolate src/lib/spindle src/lib src/hooks src/components/chat src/components/settings   # 2001 pass, 0 fail
```

In one earlier batch run, `edit-send-streaming-native-placement.preservation.vite.isolated.test.tsx` hit its 30 s timeout. It takes about 25 s alone and passes alone on this branch and on a branch without these changes.

New tests:
- `tts-api.test.ts`: `speak` resolves when its playback ends and rejects with the synthesis error; `stop()`, a newer `speak`, or host playback end it early and cancel synthesis; input and `media` checks happen before playback; `isSpeaking`/`subscribe` are free; `subscribe` reports each change once, including saved message audio, and isolates a throwing listener; revoke and unload stop only the extension's own playback and remove its listeners.
- `ttsAudio.playback-state.test.ts`: a tracked `<audio>` element counts as playback, `stopAllTTSPlayback` pauses it, and untracking clears it.
- `useMessagePlayback.test.tsx`: its `ttsAudio` mock gets the new `getPlaybackSession` export.

## Live test

A scratch Lumiverse from this branch (separate port and data dir) with two OpenAI TTS connections pointing at a local fake `/v1/audio/speech` server. The fake returns a sine WAV (0.08 s per character) and logs each request. A throwaway frontend extension with `media` logged every `subscribe` callback with a timestamp. Chrome, headless.

| Case | Result |
|---|---|
| `ctx.host.capabilities['text-to-speech-v1']` | 1 |
| `speak({ text })` (29 characters) | default connection, voice `alloy`; events `true` at 145 ms, `false` at 2590 ms; the promise resolved at 2585 ms |
| `speak({ text }, { connectionId })` | the other connection: voice `nova`, model `tts-1-hd`, its own key |
| `stop()` 800 ms into a long sentence | promise resolved at 808 ms; `false` event at 808 ms |
| a second `speak` 600 ms into the first | the first resolved at 607 ms; the second played to the end |
| text containing the fake's failure trigger | rejects "OpenAI TTS tts synthesize failed (500): fake provider failure"; `isSpeaking()` false |
| empty text / unknown `connectionId` / `messageId` + `connectionId` / unknown message | `TTS_INPUT_INVALID` / `TTS_CONNECTION_NOT_FOUND` / `TTS_INPUT_INVALID` / `TTS_MESSAGE_NOT_FOUND`, no provider request |
| `speak({ messageId })` without saved audio | host pipeline (quoted speech + narration), 1 provider request, events `true`/`false`; the audio was saved to the message like the Play button |
| the same message again | replayed the saved file, 0 provider requests |
| user clicks the saved audio player's Play | `true` event, `isSpeaking()` true |
| then `ctx.tts.stop()` | the `<audio>` element paused; `false` event |
| user plays the saved audio to its end | `true`, then `false` at the end |
| user clicks a message's "Play with TTS" (engine path) | `true`, then `false` when it ended |
| `media` revoked while the extension speaks | its playback stopped, the promise resolved; then `speak` and `stop` throw `PERMISSION_DENIED:media` |
| Text-to-Speech turned off | `speak` rejects `TTS_UNAVAILABLE:disabled` |

The fake's API key does not appear in the server log.

Auto-play of a new reply (mock LLM, auto-play on) synthesized and saved the audio, but the saved player did not start in headless Chrome. The same happened on a build without this PR, so I could not use it for this test. Auto-play ends in the two paths above (the saved `<audio>` element, or the engine fallback), and both send the events.

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [x] Frontend: `cd frontend && bun run typecheck`; `bun x eslint` on the touched files

## UI changes (if applicable)

- No visible UI change. `MessageAudioPlayer` only registers its `<audio>` element for the playback state.

## Security-sensitive changes (if applicable)

- `speak` and `stop` need `media`. `speak` spends the user's TTS provider credit on text chosen by the extension, through connections the user configured. The extension never receives keys or URLs, and gets no audio bytes back.
- `speak({ messageId })` can save the synthesized audio to the message, the same write the message's Play button does. It only covers messages of the active chat.
- `isSpeaking` and `subscribe` are free. They return one boolean.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.
