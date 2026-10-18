# Lumi Voice v0 spec

Read with DESIGN.md (user decisions), surface-audit.md + surface-catalog.json (what the host exposes),
audio-feasibility.md (audio facts), dictation-bench.md (measured Jev pipeline; code in scratch/dictation-bench/).

## Shape
- Spindle extension, identifier `lumi_voice`, entries `dist/backend.js` + `dist/frontend.js`. Bun + TypeScript.
  Reference projects for structure/build/tests: C:/Users/eme4/Choir (uses spindle.decisions/Jev), C:/Users/eme4/inlay-illustrator.
- Frontend: mic, speech-activity detection, wake word, STT, the bubble UI, action execution (host surfaces, routes, DOM fallback,
  composer). Backend: Jev (spindle.decisions), LLM (spindle.generate), embeddings (spindle.embeddings when `embeddings-v1`),
  entity lists (characters, personas, presets, connections, chats). Frontend <-> backend via the normal extension messaging.
- All models come from the user's Lumiverse connection profiles. Settings pick a profile per kind (default = host default):
  STT, Decision, LLM, Embedding, TTS. Other settings: wake word on/off, idle timeout (20 s), thought format (`*italics*`),
  dialogue quotes, OOC format `(( ))`.

## Audio (v0)
- Own getUserMedia stream (mic needs https or localhost; show a clear message otherwise). Speech-activity detection: port the
  host's SpeechActivityDetector logic (frontend/src/lib/whistle/audio.ts:131) — copy, do not import host internals.
- Idle (no session): each speech burst <= ~3 s goes to ctx.stt.transcribe (Whistle); open a session when the text starts with
  "hey lumi" (normalize case/punctuation; accept close spellings like "hey loomy"). Text after the wake word in the same burst
  is the first utterance.
- Session: every burst is transcribed and goes to the router. Don't flood the shared Whistle worker: one transcribe at a time,
  drop/merge queued bursts.
- Pause listening while host TTS plays (capture-phase play/ended listeners on <audio> elements until a host event exists;
  use ctx.tts events when the host capability exists) and while the host mic button records.
- v1 (separate work item, not in this build): sherpa-onnx KWS + Silero VAD wasm worker replaces the idle Whistle polling.
  Design the wake detector behind a small interface so v1 swaps in.

## Session + bubble
- "Hey Lumi" opens a small floating bubble (ui_panels float widget or own DOM): state (listening / thinking / asking),
  last transcript, last action, X button. Close: Jev intent "close", X, Escape, "hey lumi" again, idle timeout.
- Low confidence -> the bubble asks ("Did you mean Seo-yeon or Seo-ah?") and the next utterance answers it.
- Destructive actions (delete message/chat, anything catalog-marked destructive) always confirm by voice or click.

## Router (one Jev request per utterance, fan-out)
- Questions in one request: intent choice (close FIRST, then command, dictation, not_for_lumi), action choice over the
  candidate actions (safe "none/ask" option first), and the argument choices the candidates need. Use confidence gating.
  Field name is `instructions` (a typo is silently ignored).
- Candidates: the host surface catalog (ctx.host.surfaces.list(); refresh on change) + entity actions:
  open character, open latest/recent chat with character, new chat (if host action exists), switch LLM profile,
  switch persona, switch preset / apply theme (when host actions exist), regenerate, continue, stop, swipe, edit/delete last.
  Narrow to <= ~40 by lexical fuzzy match + embeddings (if available, cache vectors by connection_id+model);
  Jev picks. Characters: name fuzzy match; when the utterance describes looks or the name is unclear, send the top <= 8
  candidates' avatars as Jev image options (image_id, needs `images`; Jev rejects images under 280 px -> fall back to text).
- Multi-step or unmatched requests -> LLM planner: returns a JSON list of steps using only known action ids + args; code
  validates and runs them one by one; stop on the first failure and say so in the bubble.
- DOM fallback (no catalog match, e.g. "click the gear next to the preset"): collect visible labelled controls
  (button, [role=button], a, input labels, aria-label/title), ask Jev a text choice, click/focus the pick. Never on
  destructive-looking controls without confirmation.
- Every action is feature-detected (host capability / surface present). Missing host support -> the bubble says what is
  missing, no crash.

## Dictation
- Intent "dictation" (or "Lumi, write ..." / "type ...") -> pipeline from dictation-bench.md: strip stray quotes, fix ALL CAPS,
  split sentences in code, one Jev request labels units (dialogue/thought/action-narration/OOC) + paragraph boundaries
  (+ optional "different speaker" noul), code formats. If the transcript has no punctuation: LLM punctuation-only pass with a
  word-equality check, else the gap-noul fallback. The user's words are never changed.
- Result goes into the chat composer: ctx.composer when the host has it; otherwise the DOM textarea (native value setter +
  input event) — verify this actually updates React state. Append to existing draft text with a paragraph break.
- Voice follow-ups in the session: "send it", "rewrite it" (LLM rewrite with the last few chat messages, result replaces the
  draft, undo keeps the original), "clear it", "read it back" (TTS when available).

## Not in v0
sherpa KWS/VAD wasm, screenshot+Box, multi-language, mobile tuning.

## Quality bar
- Unit tests for router question building, answer handling (confidence gates), dictation segmentation/formatting, catalog
  narrowing. Fake host for tests (see the memories about fake-host shape: spindle.host / spindle.log).
- Live test on a scratch Lumiverse instance (memory recipe) with Chrome fake audio
  (--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>) and generated speech clips from
  scratch/audio/: wake -> "open my themes" -> "close". Real Jev via the user's decision connection on the scratch instance.
- Backend bundle must pass the install scanner (memory: detectDangerousBackendCapabilities). No value imports from
  lumiverse-spindle-types in src (memory).
