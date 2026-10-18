# Lumi Voice v0: build report

Date: 2026-10-18. Repo: `C:/Users/eme4/lumi-voice`, branch `master` (worker branches
`wt/audio`, `wt/dictation`, `wt/router` are merged). Host for live tests: Lumiverse `origin/staging` @ `2a8d9461`
(scratch worktree `C:/Users/eme4/lv-wt-lumivoice-qa`, port 7893, data in `scratch/qa-data`), Chrome with a fake mic
(`--use-file-for-fake-audio-capture`, SAPI voices), real Jev (TypeSafe decision connection, model `jev-preview`) and a
real LLM (Custom connection to the local Gemini proxy).

Tags: **[live]** = ran on the scratch Lumiverse in Chrome. **[unit]** = `bun test` only. **[eval]** = worker eval scripts
against real Jev/LLM outside Lumiverse. **[code]** = written, not run.

## What it is

- `spindle.json`: identifier `lumi_voice`; permissions `media, decisions, generation, chats, characters, personas,
  presets, images, chat_mutation` (`ui_panels` dropped: the bubble is own DOM). Entries `dist/backend.js` (52.5 KB) + `dist/frontend.js` (53.0 KB).
- Backend bundle passes the real install scanner (`detectDangerousBackendCapabilities` → `[]`, `scripts/scan.ts`) and has
  no `lumiverse-spindle-types` runtime code.
- `bun test src`: 108 pass, 0 fail. `tsc --noEmit`: clean.

### Layout
| Area | Files | Owner |
|---|---|---|
| Contract | `src/shared/protocol.ts` (RPC + router/dictation types), `settings.ts`, `host-ext.ts` (in-flight host API shapes) | lead |
| Backend | `src/backend.ts`, `backend/handlers.ts` (RPC), `services/` (Jev, LLM, embeddings per profile), `entities.ts` | lead |
| Router | `src/backend/router/*` (narrowing, one Jev request, gates, ask/pending, planner, DOM pick) | lv-router |
| Dictation | `src/backend/dictation/*` (approach J port, punctuation fallbacks, rewrite) | lv-dictation |
| Audio | `src/frontend/audio/*` (capture worklet, burst cutter, transcriber, text wake word, pause gates) | lv-audio |
| Frontend | `src/frontend.ts`, `frontend/session.ts`, `bubble.ts`, `actions.ts`, `candidates.ts`, `draft.ts`, `dom-fallback.ts`, `settings-panel.ts`, `rpc.ts` | lead |
| v1 wake word | `src/frontend/audio/kws/*` (sherpa-onnx KWS, untracked, sibling `kws-wasm-build`) | sibling |

## Works on current staging

| Feature | Status | Evidence |
|---|---|---|
| Mic → speech bursts → `ctx.stt.transcribe` (Whistle) | **[live]** | fake-mic runs below; burst cutter also checked on real clips **[unit]** |
| "Hey Lumi, open my themes" → Theme drawer opens; "That's about it, I don't need anything else" → session closes | **[live]** spec test passed | wake at ~7.7 s of the clip (speech end + 1.6 s silence + Whistle), route+action ~0.5 s after the transcript; screenshot `scratch/live/s1_after.png` |
| Wake word, then dictation, then "Send it" | **[live]** | sent message: `She leans against the door frame and smiles. "You came back," she says quietly.` ¶ `*I wonder if she knows what I did.*` |
| "Open the character list" → character browser; "Start a new chat with Seo-yeon" → **degraded**: opens Seo-yeon's page and says starting chats by voice needs a newer Lumiverse | **[live]** | right character picked (2 similar names) |
| Typed input in the bubble (same path as speech) | **[live]** | used for the rows below |
| "open voice settings" → Settings › Voice | **[live]** via backend `spindle.ui.openSettings` fallback (staging lists no settings tabs, see Host notes) | screenshot `scratch/live/settings.png` |
| "swipe left" → backend swipe fallback ("This is already the first swipe.") | **[live]** | |
| "delete the last message" → confirm Yes/No; "no" → nothing deleted | **[live]** | |
| "click the attach button" → DOM fallback (visible labelled controls → Jev choice) clicked "Attach file" | **[live]** | |
| "Lumi, write she waves at him and says see you tomorrow" → LLM punctuation pass + Jev labels → `She waves at him and says, "See you tomorrow!"` | **[live]** | words unchanged (marks/case only) |
| "rewrite it" (LLM with chat context) → "undo" restores | **[live]** | |
| "switch my persona to Mira" → backend `personas.switchActive` fallback | **[live]** | `activePersonaId` = Mira |
| "Claude Sonnet please, switch the connection" → `ctx.connections.setActiveAcknowledged` | **[live]** | `activeProfileId` = Claude Sonnet ("switch to claw" asked "Did you mean Claude Sonnet?") |
| "regenerate that" → `action-regenerate` | **[live]** | new swipe created |
| "apply the emerald theme" → **degraded**: "Applying themes by voice needs a newer Lumiverse." | **[live]** | |
| "stop" while idle → closes the session; while a reply streams → stop generation | idle **[live]**, streaming **[unit]** | Lumi Voice's own drawer tab / input-bar action are no longer candidates (filtered by the catalog `owner` of our own entries) |
| "stop listening" → mic off; "close Lumi" → close | **[live]** / **[eval]** | new Lumi actions `lumi:stop_listening`, `lumi:close` |
| "Thanks, Lumi, but..." right after "Opening Theme" → close | **[live]** + **[eval]** | close option lists thank-you/bye examples; state has `lumi_last_said` (the bubble's line) |
| Escape closes; X closes; idle timeout closes; "hey lumi" again closes | Escape **[live]**, rest **[unit]** | |
| Composer without `ctx.composer`: native value setter + `input` event on `textarea[name="chat-message"]` updates React state; send by clicking the button next to it | **[live]** | the sent message had the injected text |
| Settings drawer tab (listening on/off, wake word, idle timeout, profile per kind, dictation format, host support list) | **[code]** + loads **[live]** | not clicked through |
| `ctx.settings` keys must be `module:key` (`voice:settings`) | **[live]** (a plain `settings` key throws `SETTING_KEY_INVALID`) | |

Worker numbers (details in their commits):
- Router **[eval]** real Jev, re-run after the decisions below: dev 54/54 in 2 of 3 runs ("go home" flaked once to
  ignore: intent not_for_lumi 0.29 / action Home 0.46), held-out 40/40, p50 ~280 ms. First run: dev 49/49, held-out 40/40 (39/40 before one fix); planner only for multi-step
  (2/2 correct, ~1.2-1.5 s); DOM pick 8/8, p50 ~230 ms; portraits 5/8 (all 3 misses: target not among the 8 sent).
- Dictation **[eval]**: request bodies byte-identical to the bench; real Jev held-out punctuated 100.0% word labels
  (bench 100.0%), hard 97.1% (bench 97.1%), unpunctuated with LLM pass 98.8% (bench 98.8%); p50 0.23-0.25 s (1.2-1.4 s with the LLM pass).
- Audio: `matchWake` on the recorded Whistle outputs 77/87 hits, 0/134 false (spec regex: 70/0); real Chrome capture
  → resample → cut → Whistle end to end **[eval]**.

## Uses in-flight host PRs when present (feature-detected, unit tested only)

| Host PR | Detection | Used for | Without it |
|---|---|---|---|
| #473 `ctx.composer` | `composer-v1` + member | draft read/write/send | DOM textarea (works on staging **[live]**) |
| #475 stop/swipe commands | `action-stop-generation` etc. in `surfaces.list()` | stop, swipe | stop = DOM stop button **[code]**; swipe = backend `chat.updateMessage` **[live]**; swipe right past the end = regenerate **[unit]** |
| #476 `entity_action` | entry in `surfaces.list(['entity_action'])` | new/latest chat, persona, preset, theme (theme list from `params.themeId.oneOf`) | latest chat via `ctx.chats.listForCharacter` + route **[unit]**; persona via backend **[live]**; new chat/preset/theme: clear "needs a newer Lumiverse" **[live]** |
| #477 connections by kind | `connection-kinds-v1` | STT/TTS profile pickers | pickers show "Lumiverse default" only |
| #478 `ctx.tts` | `text-to-speech-v1` | "read it back", spoken replies, pause while TTS plays | "read it back" says it needs a newer Lumiverse; pause uses capture-phase `<audio>` events **[unit]** |
| #474 STT options | `speech-to-text-options-v1` | keywords `Lumi` + character/persona names, word timings; `ctx.stt.onHostActivity` pause | no keywords; host mic pause via `button[aria-live]` observer **[unit]** |
| #472 embeddings | `embeddings-v1` + `spindle.embeddings` | candidate narrowing (vectors cached by connection+model) | lexical fuzzy only (router eval was 100% without embeddings) |

## Degraded / not done

- **Settings tabs on staging**: `ctx.host.surfaces.list()` has no settings tabs (host bug fixed by #475). Lumi Voice reads
  them from `spindle.ui.getSettingsTabs()` and opens them with `spindle.ui.openSettings()` (both free) **[live]**.
- **Wake word v0** is Whistle text matching on bursts: only the first ~3 s of an idle burst is transcribed for the match.
  Wake latency = end of speech + 1.6 s silence + Whistle. The sherpa-onnx v1 detector (sibling, untracked in
  `src/frontend/audio/kws/`) implements the same `WakeDetector` interface; asset hosting is still a placeholder, so it is not wired in.
- Dictation split by pauses: a pause > 1.6 s starts a new burst; each burst is routed and appended (joined with a space
  when it continues Lumi's previous insert, else a paragraph break). Long dictations with pauses are not merged into one Jev request.
- Pause gates (TTS / host mic) are unit tested only; not checked against real host TTS or the real mic button.
- Stop without #475 uses the DOM stop button **[code]** (not run: no long generation in the tests).
- Jev images (character portraits) are sent only when `decision-images-v1`, the `images` permission and a 280-1568 px
  `image_id` are all there; the scratch characters had no avatars, so this path is **[eval]** only.
- Not built (per spec): sherpa KWS/VAD wasm, screenshot + Jev box, multi-language, mobile tuning.

## Decisions taken after the first report (parent, 2026-10-18)

1. Jev model: the Decision profile's model is used as is. The settings panel shows a one-line hint when that model is
   not jev-preview / 1.14 **[code]**.
2. Own surfaces dropped from the candidates; new Lumi actions `stop listening` and `close`; "stop" = stop generation while
   a reply streams, else close **[live]**.
3. Characters are ordered recent-first by the characters of recent chats (`RouteContext.recentCharacterIds` from
   `ctx.chats.listRecent`), then host order; narrowing ties and portrait picks keep this order **[unit]**.
4. Bubble stays own DOM above modals; `ui_panels` removed from the manifest **[live]** (re-imported, permissions re-granted).
5. Close stays with Jev: richer close examples + `lumi_last_said` in state **[eval]** + **[live]**.

## Open questions (first report; 1-5 answered above)

1. **Jev model**: router and dictation were tuned on `jev-preview` (1.14). A Decision profile on `jev-latest` (1.13) is
   a bit worse (dictation bench) and the Jev gap fallback is better on 1.13. Should Lumi Voice pass `model: 'jev-preview'`
   per request (the API allows it), or keep the profile's model?
2. (answered) "stop" while idle asks "Stop generation or Lumi Voice?" because our own drawer tab/input-bar action are candidates.
   Drop our own surfaces from the candidates (and add a "stop listening" Lumi action instead)?
3. Character order for portrait options: the backend lists characters in host order; recent-first would help looks-based
   picks (router open issue 1). A host `characters.list({sort:'recent'})` or using recent chats first?
4. The bubble is own DOM at z-index 100000 (above host modals, so it stays visible over Settings). OK, or use a
   `ui_panels` float widget (draggable, but under modals)? If own DOM, `ui_panels` can be dropped from the manifest.
5. Session close on "Thanks Lumi, bye" failed once because Whistle heard "Thanks, Lumi, but..." (routed as not-for-Lumi).
   Add a "bye/thanks" keyword shortcut, or leave it to Jev?
6. Persona switch via backend: the memory note says a page can reset a REST-set `activePersonaId` unless the persona is
   default; it held in this test, but #476 is the reliable path.

## How to run

```
bun install && bun test src && bun run build
# scanner (from a Lumiverse checkout): bun run <lumi-voice>/scripts/scan.ts <lumi-voice>/dist/backend.js
```
Live test scripts are in the lead's REPL (Playwright, `scratch/live/*.wav` scenarios made with SAPI).
