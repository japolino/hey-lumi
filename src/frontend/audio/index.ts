/**
 * Audio pipeline factories. Owner: audio worker. Contract only until the implementation lands.
 */
import type { FrontendCtx } from "../../shared/host-ext";
import type { MicCapture, Transcriber, WakeDetector } from "./types";

export * from "./types";

/** Own getUserMedia stream (echo cancellation + noise suppression), AudioWorklet to 16 kHz, speech-activity bursts. */
export function createMicCapture(): MicCapture {
  throw new Error("NOT_IMPLEMENTED: createMicCapture");
}

/**
 * ctx.stt.transcribe for bursts. `getProfile()` returns the STT connection id ("" = host default; Whistle when the
 * default cannot transcribe supplied audio). Passes keywords ["Lumi"] and asks for words when the host has
 * speech-to-text-options-v1.
 */
export function createTranscriber(_ctx: FrontendCtx, _getProfile: () => string): Transcriber {
  throw new Error("NOT_IMPLEMENTED: createTranscriber");
}

/** v0 wake detector: transcribe each burst and match "hey lumi" at the start (see matchWake). */
export function createTextWakeDetector(_transcriber: Transcriber): WakeDetector {
  throw new Error("NOT_IMPLEMENTED: createTextWakeDetector");
}

/** "Hey Lumi" at the start of a transcript (case/punctuation-insensitive, close spellings; never "Louis"). */
export function matchWake(_text: string): { rest: string } | null {
  throw new Error("NOT_IMPLEMENTED: matchWake");
}

/**
 * Pause the mic while host TTS plays (ctx.tts.subscribe when the host has text-to-speech-v1, else capture-phase
 * play/ended listeners on <audio>/<video>) and while the host mic records (ctx.stt.onHostActivity when present, else
 * a DOM observer). Calls `capture.setPaused("tts" | "host_mic", ...)`. Returns a stop function.
 */
export function watchPauseGates(_ctx: FrontendCtx, _capture: MicCapture): () => void {
  throw new Error("NOT_IMPLEMENTED: watchPauseGates");
}
