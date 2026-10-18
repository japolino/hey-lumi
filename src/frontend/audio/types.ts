/** Audio contract (spec/SPEC.md "Audio (v0)"). All PCM is 16 kHz mono Float32. */

export const SAMPLE_RATE = 16000;

export interface SpeechBurst {
  samples: Float32Array;
  sampleRate: typeof SAMPLE_RATE;
  durationMs: number;
  /** performance.now() when the burst ended. */
  endedAt: number;
}

/** A live audio stream: raw frames for frame-based detectors (v1 KWS) and speech bursts cut by speech-activity detection. */
export interface AudioSource {
  /** 16 kHz mono frames (tens of ms each) while capturing and not paused. */
  onFrames(listener: (samples: Float32Array) => void): () => void;
  /** One complete speech burst (speech start to end of trailing silence, capped in length). */
  onBurst(listener: (burst: SpeechBurst) => void): () => void;
  /** Confirmed speech started (bubble "hearing you", idle timer reset). */
  onSpeechStart(listener: () => void): () => void;
}

export type MicErrorCode = "insecure_context" | "unsupported" | "denied" | "no_device" | "failed";

export class MicError extends Error {
  constructor(
    readonly code: MicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MicError";
  }
}

/** The extension's own getUserMedia stream + AudioWorklet resampler + speech-activity detector. */
export interface MicCapture extends AudioSource {
  /** Opens the mic. Rejects with MicError. Safe to call again while running. */
  start(): Promise<void>;
  /** Releases the mic and audio graph. */
  stop(): void;
  readonly running: boolean;
  /**
   * Pause for a named reason (e.g. "tts", "host_mic", "busy"). Paused while any reason is set: frames and bursts are
   * dropped and a burst in progress is discarded.
   */
  setPaused(reason: string, paused: boolean): void;
  readonly paused: boolean;
}

export interface WakeHit {
  /** Text said after the wake word in the same burst ("" when unknown or nothing). */
  rest: string;
}

/** "Hey Lumi" detector. v0: Whistle text match on bursts. v1: sherpa-onnx KWS on frames (same interface). */
export interface WakeDetector {
  start(source: AudioSource, onWake: (hit: WakeHit) => void): Promise<void>;
  stop(): void;
}

export interface TranscriptResult {
  text: string;
  words?: Array<{ word: string; start: number; end: number; probability: number }>;
}

/** ctx.stt.transcribe with one request in flight; bursts that arrive while busy are merged into one next request. */
export interface Transcriber {
  /** Resolves null when this burst was merged into a later one (only the merged request's caller gets the text). */
  transcribe(burst: SpeechBurst): Promise<TranscriptResult | null>;
}
