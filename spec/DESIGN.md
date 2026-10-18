# Lumi Voice: design decisions (from the user conversation, 2026-10-18)

Lumiverse extension (Spindle). Working name "Lumi Voice", identifier `lumi_voice` (assumption, not confirmed).

## Part 1: voice control
- Always listening for the wake word "Hey Lumi" (local wake-word model, e.g. openWakeWord in the browser; v0 may use
  VAD + Lumiverse STT on short bursts and match the text).
- Wake word opens a small listening bubble. The session stays open for several commands.
- Close: Jev intent option "close" ("that's about it", "I don't need anything else"), the bubble's X, Escape,
  "Hey Lumi" again, and an idle timeout (~20 s, setting).
- Each utterance -> Lumiverse STT -> one Jev request: intent (close first: Jev leans to the first option) /
  command / dictation / not addressed to Lumi, plus target + arguments for commands (TypeSafe "function calling" pattern).
- Low confidence -> the bubble asks a short follow-up. Undoable actions run; destructive ones always confirm.
- Targets: Lumiverse host surfaces (drawer tabs, settings tabs, commands, routes, modals, input bar actions,
  extension commands; each has label/description/keywords) plus entities (characters, connection profiles,
  personas, presets, themes, chats...). Characters can be matched by appearance: avatars go to Jev as image options
  ("the red haired one, Seo something").
- Big lists are narrowed first (fuzzy name match; embeddings via the user's embedding connection profile once a host
  API exists), then Jev picks.
- Multi-step / unknown requests -> planner LLM writes steps from the known action list; code runs them.
- Fallback for UI with no catalog entry: screenshot + Jev Box question -> click the box centre (experimental:
  TypeSafe images/Box are "Dreamer-ready").

## Part 2: smart dictation for RP
- After dictation, Jev labels each sentence (dialogue / thought / action / narration / OOC) and each boundary
  (new paragraph yes/no) in one fan-out request; code formats (quotes, *italics* for thoughts - setting).
  The user's words are kept exactly.
- Optional "Rewrite" button: LLM rewrite with recent chat context.

## Models
- No model settings of its own. Everything goes through the user's Lumiverse connection profiles: STT, Decision (Jev),
  LLM, Embedding, TTS (optional voice replies). Settings only pick which profile of each kind (default = Lumiverse default).

## Host limitations
- Allowed: PRs to prolix-oc/Lumiverse (base `staging`) and prolix-oc/lumiverse-spindle-types from the fork japolino.
- Known gap: no extension API to embed text with an embedding connection profile (spindle-types 0.6.51 only has
  registerEmbeddingDriver). Host embeddings service is text-only.
