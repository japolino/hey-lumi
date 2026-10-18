import type { AudioSource, SpeechBurst, Transcriber, WakeDetector } from "./types";

/**
 * "hey"/"hay" (also "he", "a": Whistle drops the h) + a "lumi" spelling as whole words at the start.
 * Never "Louis", "Louie", "Lucy", "Lou", "loony", "Okay Lumi".
 */
const WAKE = /^[\P{L}]*(?:hey|hay|hei|he|a)[\P{L}]+(?:l(?:u|oo|o)m+(?:i|y|ie|ee|ey)|looming)(?![\p{L}\p{N}'])/iu;

export function matchWake(text: string): { rest: string } | null {
  const m = WAKE.exec(text);
  if (!m) return null;
  return { rest: text.slice(m[0].length).replace(/^[\s\p{P}]+/u, "").trim() };
}

/** Only this much of an idle burst is transcribed to look for the wake word. */
const HEAD_MS = 3000;

function head(burst: SpeechBurst): SpeechBurst {
  if (burst.durationMs <= HEAD_MS) return burst;
  return { ...burst, samples: burst.samples.subarray(0, (HEAD_MS / 1000) * burst.sampleRate), durationMs: HEAD_MS };
}

/** v0 wake word: transcribe the start of each burst and match "hey lumi"; a long burst is then transcribed whole for `rest`. */
export function createTextWakeDetector(transcriber: Transcriber): WakeDetector {
  let off: (() => void) | null = null;

  const check = async (burst: SpeechBurst, onWake: (hit: { rest: string }) => void, active: () => boolean) => {
    const short = head(burst);
    const first = await transcriber.transcribe(short);
    const hit = first && matchWake(first.text);
    if (!hit || !active()) return;
    if (short === burst) return onWake(hit);
    const full = await transcriber.transcribe(burst);
    if (!active()) return;
    onWake((full && matchWake(full.text)) || hit);
  };

  return {
    async start(source: AudioSource, onWake) {
      off?.();
      const unsubscribe = source.onBurst((burst) => {
        check(burst, onWake, () => off === stop).catch((error) => console.warn("[lumi-voice] wake transcription failed", error));
      });
      const stop = () => unsubscribe();
      off = stop;
    },
    stop() {
      off?.();
      off = null;
    },
  };
}
