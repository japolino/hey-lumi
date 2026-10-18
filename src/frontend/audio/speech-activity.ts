import { SAMPLE_RATE } from "./types";

export interface BurstCutterOptions {
  /** Audio kept from before speech was detected, so the first word is not cut. */
  preRollMs?: number;
  /** Speech needed before a burst is confirmed. */
  confirmMs?: number;
  /** Silence that ends a burst. */
  endSilenceMs?: number;
  /** Silence kept after the last speech frame. */
  tailMs?: number;
  /** Bursts with less speech span than this are dropped. */
  minSpeechMs?: number;
  /** Longer bursts are cut at this length. */
  maxBurstMs?: number;
}

export interface BurstCutter {
  /** Feed one frame of 16 kHz PCM. */
  push(frame: Float32Array): void;
  /** Drop a burst in progress. */
  reset(): void;
}

const ms = (samples: number) => (samples / SAMPLE_RATE) * 1000;

/**
 * Cuts speech bursts from a 16 kHz frame stream. RMS against an adaptive noise floor, like the host's
 * SpeechActivityDetector (whistle/audio.ts): ~140 ms of speech confirms, ~1.6 s of silence ends a burst.
 */
export function createBurstCutter(
  onBurst: (samples: Float32Array) => void,
  onSpeechStart: () => void,
  options: BurstCutterOptions = {},
): BurstCutter {
  const { preRollMs = 250, confirmMs = 140, endSilenceMs = 1600, tailMs = 300, minSpeechMs = 400, maxBurstMs = 60_000 } = options;
  let noiseFloor = 0.006;
  let preRoll: Float32Array[] = [];
  let frames: Float32Array[] = [];
  let length = 0;
  let speechMs = 0;
  let confirmed = false;
  let firstSpeechEnd = 0;
  let lastSpeechEnd = 0;

  const reset = () => {
    frames = [];
    length = 0;
    speechMs = 0;
    confirmed = false;
  };

  const emit = (end: number) => {
    const out = new Float32Array(end);
    let at = 0;
    for (const f of frames) {
      if (at >= end) break;
      out.set(f.subarray(0, end - at), at);
      at += f.length;
    }
    reset();
    preRoll = [];
    onBurst(out);
  };

  const keepPreRoll = (frame: Float32Array) => {
    preRoll.push(frame);
    let total = preRoll.reduce((n, f) => n + f.length, 0);
    while (preRoll.length > 1 && ms(total - preRoll[0]!.length) >= preRollMs) total -= preRoll.shift()!.length;
  };

  return {
    reset() {
      reset();
      preRoll = [];
    },
    push(frame) {
      const frameMs = ms(frame.length);
      let sum = 0;
      for (const s of frame) sum += s * s;
      const rms = Math.sqrt(sum / Math.max(1, frame.length));
      const loud = rms >= Math.max(0.012, noiseFloor * 3);

      if (!length) {
        if (!loud) {
          noiseFloor += (rms - noiseFloor) * 0.05 * (frameMs / 100);
          keepPreRoll(frame);
          return;
        }
        frames = preRoll;
        preRoll = [];
        length = frames.reduce((n, f) => n + f.length, 0);
        firstSpeechEnd = length + frame.length;
      }
      frames.push(frame);
      length += frame.length;

      if (loud) {
        speechMs += frameMs;
        lastSpeechEnd = length;
        if (!confirmed && speechMs >= confirmMs) {
          confirmed = true;
          onSpeechStart();
        }
      } else if (!confirmed) {
        speechMs -= frameMs;
        noiseFloor += (rms - noiseFloor) * 0.05 * (frameMs / 100);
        if (speechMs <= 0) {
          // A click or a short noise: back to idle, keep the audio as pre-roll.
          const old = frames;
          reset();
          for (const f of old) keepPreRoll(f);
          return;
        }
      }

      if (!confirmed) return;
      if (ms(length) >= maxBurstMs) return emit(length);
      if (ms(length - lastSpeechEnd) < endSilenceMs) return;
      const speechSpan = ms(lastSpeechEnd - firstSpeechEnd) + frameMs;
      if (speechSpan < minSpeechMs) {
        reset();
        return;
      }
      emit(Math.min(length, lastSpeechEnd + Math.round((tailMs / 1000) * SAMPLE_RATE)));
    },
  };
}
