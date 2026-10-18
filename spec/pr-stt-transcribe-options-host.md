## Summary

Two small additions to the frontend speech API (`ctx.stt`) for extensions that listen all the time, such as a voice assistant with a wake word.

**1. `transcribe()` options for Whistle: `keywords` and `words`**

- `keywords?: string[]`: names and words to favour, e.g. `["Lumi", "Seo-yeon"]`. Whistle's native engine already has a keywords argument (`_needle_transcribe(..., keywords, ...)`), but `runtime.ts` always passed `0`. It now passes the list, newline-separated (the format of Cactus's own Python binding, `needle/agent/whistle.py` `_options`). The list goes to every 28 s window.
- `words?: boolean`: with `words: true` the transcript also has `words: [{ word, start, end, probability }]`. Whistle already computes these (the host requests timestamps and `TranscriptAssembler` joins the windows with them), but `transcribe()` returned only `text`. Times are seconds from the start of the supplied audio, across windows.
- Validation: at most 500 keywords, each 1-100 characters after trimming, no line breaks (a line break would split one keyword into two). Anything else rejects with `STT_OPTIONS_INVALID`. The list is copied before use.
- Only Whistle uses the options. STT connections ignore `keywords` and return no `words`. Web Speech cannot transcribe supplied audio, as before. `start()` does not take the options.

**2. Host microphone activity: `onHostActivity(listener)` and `isHostCapturing()`**

- The chat composer's mic button (`InputArea`, `createSTTEngine`) does not use the extension mic lock (`captureOwner` in `stt-api.ts`), and extensions could not see when it was on. An always-listening extension competes with it for the shared Whistle worker (one queue, `whistle.worker.ts`) and hears the user's dictation.
- New module `frontend/src/lib/sttHostCapture.ts` holds the state. `InputArea` holds it while `sttStatus` is `starting`, `listening` or `processing` (one `useEffect`), so "active" lasts until the final transcription is done.
- `ctx.stt.onHostActivity(listener)` calls `listener(true)` / `listener(false)` and returns an unsubscribe function. `ctx.stt.isHostCapturing()` returns the current state. Recordings started by extensions through `ctx.stt.start()` are not reported.
- Both are free (authority rows `ctx.stt.onHostActivity` / `ctx.stt.isHostCapturing`, basis `limb-e`): the composer already shows the same on/off state as a recording indicator in the shared DOM. No audio or text crosses. Listener errors are caught and logged; unload removes all listeners.

**Feature detection:** host capability `speech-to-text-options-v1: 1` (in `SPINDLE_STT_HOST_CAPABILITIES`, next to `speech-to-text-v1`).

**Types:** https://github.com/prolix-oc/lumiverse-spindle-types/pull/68 (`SpindleSTTTranscribeOptions`, `SpindleSTTWord`, `SpindleSTTTranscript.words`, the two optional methods, and the capability). `frontend/package.json` pins that commit. Only the frontend uses these types, so the root pin is unchanged.

Docs: `developer-docs/docs/frontend-api/speech-to-text.md` (new "Keywords and word timings" section, API table rows, pause example).

## Validation

```text
cd frontend && bun run typecheck                    # 0 errors
cd frontend && bunx eslint <changed files>          # 0 problems
cd frontend && bun test src/lib/spindle/stt-api.test.ts src/lib/whistle src/lib/spindle/frontend-authority-map.test.ts   # 69 pass, 0 fail
cd frontend && bun test --isolate src/lib/spindle   # 527 pass, 0 fail (includes the loader lifecycle contract)
```

New tests: keywords copied and trimmed and passed with the words flag; invalid keywords (line break, empty, 101 characters, 501 entries, a string, a number) reject before transcription; keywords reach every window and words come back on the recording timeline across windows; host activity reaches listeners without `media`, a throwing listener does not break others, unsubscribe and teardown stop delivery, and stale API references throw `SPINDLE_FRONTEND_INACTIVE`. Authority-map test covers the two free rows.

Native engine, run in Bun with the shipped `needle-c19b9ddf9c7d.wasm` and `whistle-b6e02f048568.cact` through the changed `WhistleRuntime` + `transcribeWhistleAudio` (synthetic TTS clips):

| Clip | Without keywords | With `Lumi, Seo-yeon, Claude, ...` |
|---|---|---|
| "Hey Lumi. Switch the connection profile to Claude ..." | `HAY LUMY Switch the connection profile to claw ...` | `Hay Lumi Switch the connection profile to Claude ...` |
| "... Stay behind me, Seo-yeon. ..." | `... "Seo Yeon." ...` | `... Stay behind me, Seo-yeon. ...` |
| 58 s narration (3 windows) | same text | same text, 155 words, times increase across windows, last word at 56.9 s |

Also checked on the native engine: comma-separated keywords in one string do nothing (newlines are needed); 1,000 keywords cost no measurable time on a 7 s clip (~1.5 s with or without).

## Live test

A scratch Lumiverse from this branch (own port and data dir, frontend built from the branch), headless Chrome with a fake microphone, Voice provider set to Whistle, and a throwaway frontend extension with `media`:

- `ctx.host.capabilities['speech-to-text-options-v1']` is 1; `onHostActivity` and `isHostCapturing` exist.
- `transcribe(wavBlob, { provider: 'whistle', keywords: ['Lumi', 'Claude'], words: true })` in the browser Worker: text `Hay Lumi Switch the connection profile to Claude ...` with 18 words (`Lumi` 0.40-0.80 s, p 0.49). Without options: `HE LUMY ... to claw ...`, no `words` key. Keywords without `words: true`: no `words` key.
- Bad keywords reject with `STT_OPTIONS_INVALID`.
- Clicking the composer mic button: listener got `true` (`isHostCapturing()` true), stopping it: `false` after the transcription finished. A `ctx.stt.start()` session from the extension sent no events and `isHostCapturing()` stayed false.

Not tested live: an STT connection with these options (no connection on the scratch instance; the code passes neither option to `/stt/transcribe`).

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [ ] Backend: no backend changes
  - [x] Frontend: `cd frontend && bun run typecheck`, `bun run lint` (on the changed files)

## UI changes (if applicable)

No visible UI change. The composer mic button behaves as before.

## Security-sensitive changes (if applicable)

- `keywords` and `words` stay inside the existing `media`-gated `ctx.stt.transcribe`. Keywords go only to the on-device Whistle engine; nothing is sent to STT connections.
- `onHostActivity` / `isHostCapturing` are free and expose one boolean: whether the composer's own speech session is on. The same state is visible in the shared DOM. No audio, levels or text are exposed.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.