import { CAP, hasCap, type FrontendCtx, type SttTranscribeOptionsExt } from "../../shared/host-ext";
import { SAMPLE_RATE, type SpeechBurst, type Transcriber, type TranscriptResult } from "./types";
import { encodeWav } from "./wav";

/** Silence put between bursts that are merged into one request. */
const GAP_SAMPLES = Math.round(0.3 * SAMPLE_RATE);

/** Whistle output fixes: no double quotes (they are often wrong), ALL-CAPS sentences to sentence case. */
export function cleanTranscript(text: string): string {
  const unquoted = text.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  return unquoted.replace(/[^.!?]+[.!?]*/g, (sentence) => {
    if (/\p{Ll}/u.test(sentence) || (sentence.match(/\p{Lu}/gu)?.length ?? 0) < 4) return sentence;
    const lower = sentence.toLowerCase().replace(/\bi\b/g, "I");
    return lower.replace(/\p{L}/u, (c) => c.toUpperCase());
  });
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + GAP_SAMPLES * (parts.length - 1));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length + GAP_SAMPLES;
  }
  return out;
}

/** Keyword bias for Whistle: "Lumi" first, then the caller's names; host limits are 500 keywords of 100 chars, one line each. */
export function keywordList(extra: string[]): string[] {
  const words = ["Lumi", ...extra].map((k) => k.replace(/\s+/g, " ").trim()).filter((k) => k && k.length <= 100);
  return [...new Set(words)].slice(0, 500);
}

const audioUnsupported = (error: unknown) => String((error as Error)?.message ?? error).startsWith("STT_AUDIO_UNSUPPORTED");

/**
 * Host default modes, tried in order when the host says it cannot take the audio: PCM (Whistle), WAV (an STT
 * connection), then Whistle explicitly (the default is Web Speech, which cannot transcribe supplied audio).
 */
type DefaultMode = "pcm" | "wav" | "whistle";

export function createTranscriber(ctx: FrontendCtx, getProfile: () => string, getKeywords: () => string[] = () => []): Transcriber {
  let defaultMode: DefaultMode = "pcm";
  let busy = false;
  let queued: { parts: Float32Array[]; resolve: (r: TranscriptResult | null) => void; reject: (e: unknown) => void } | null = null;

  const request = async (samples: Float32Array): Promise<TranscriptResult> => {
    const stt = ctx.stt;
    if (!stt) throw new Error("Speech-to-text is not available: Lumi Voice needs the 'media' permission and a Lumiverse with ctx.stt.");
    const base: SttTranscribeOptionsExt = { language: "en" };
    if (hasCap(ctx.host, CAP.sttOptions)) Object.assign(base, { keywords: keywordList(getKeywords()), words: true });
    const pcm = { samples, sampleRate: SAMPLE_RATE };
    const profile = getProfile();
    if (profile) return stt.transcribe(encodeWav(samples, SAMPLE_RATE), { ...base, provider: "connection", connectionId: profile });
    for (;;) {
      try {
        if (defaultMode === "pcm") return await stt.transcribe(pcm, base);
        if (defaultMode === "wav") return await stt.transcribe(encodeWav(samples, SAMPLE_RATE), base);
        return await stt.transcribe(pcm, { ...base, provider: "whistle" });
      } catch (error) {
        if (defaultMode === "whistle" || !audioUnsupported(error)) throw error;
        defaultMode = defaultMode === "pcm" ? "wav" : "whistle";
      }
    }
  };

  const run = async (samples: Float32Array): Promise<TranscriptResult> => {
    busy = true;
    try {
      const result = await request(samples);
      return { text: cleanTranscript(result.text ?? ""), ...(result.words ? { words: result.words } : {}) };
    } finally {
      busy = false;
      const next = queued;
      queued = null;
      if (next) run(concat(next.parts)).then(next.resolve, next.reject);
    }
  };

  return {
    transcribe(burst: SpeechBurst) {
      if (!busy) return run(burst.samples);
      return new Promise((resolve, reject) => {
        if (queued) queued.resolve(null);
        queued = { parts: [...(queued?.parts ?? []), burst.samples], resolve, reject };
      });
    },
  };
}
