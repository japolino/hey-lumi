import { describe, expect, test } from "bun:test";
import type { FrontendCtx, SttTranscribeOptionsExt } from "../../shared/host-ext";
import { cleanTranscript, createTranscriber, keywordList } from "./transcriber";
import type { SpeechBurst } from "./types";

type Audio = Blob | { samples: Float32Array; sampleRate: number };
interface Call {
  audio: Audio;
  options: SttTranscribeOptionsExt;
  resolve: (text: string) => void;
}

function fakeCtx(opts: { capabilities?: Record<string, number>; fail?: (call: Omit<Call, "resolve">) => Error | null } = {}) {
  const calls: Call[] = [];
  const ctx = {
    host: { capabilities: opts.capabilities ?? {} },
    stt: {
      transcribe(audio: Audio, options: SttTranscribeOptionsExt = {}) {
        const error = opts.fail?.({ audio, options });
        if (error) return Promise.reject(error);
        return new Promise((resolve) => calls.push({ audio, options, resolve: (text) => resolve({ text, provider: "whistle" }) }));
      },
      listProviders: () => [],
    },
  } as unknown as FrontendCtx;
  return { ctx, calls };
}

const burst = (n: number): SpeechBurst => ({ samples: new Float32Array(n), sampleRate: 16000, durationMs: n / 16, endedAt: 0 });
const tick = () => new Promise((r) => setTimeout(r, 0));
const samplesOf = (audio: Audio) => (audio as { samples: Float32Array }).samples;

describe("createTranscriber", () => {
  test("one request in flight; bursts that arrive meanwhile merge into one next request", async () => {
    const { ctx, calls } = fakeCtx();
    const t = createTranscriber(ctx, () => "");
    const a = t.transcribe(burst(1000));
    const b = t.transcribe(burst(2000));
    const c = t.transcribe(burst(3000));
    expect(calls.length).toBe(1);
    expect(await b).toBeNull();
    calls[0]!.resolve("first");
    expect(await a).toEqual({ text: "first" });
    await tick();
    expect(calls.length).toBe(2);
    expect(samplesOf(calls[1]!.audio).length).toBe(2000 + 4800 + 3000);
    calls[1]!.resolve("merged");
    expect(await c).toEqual({ text: "merged" });
  });

  test("an STT profile sends a WAV blob to that connection", async () => {
    const { ctx, calls } = fakeCtx();
    void createTranscriber(ctx, () => "conn-1").transcribe(burst(1600));
    expect(calls[0]!.audio).toBeInstanceOf(Blob);
    expect(calls[0]!.options).toMatchObject({ provider: "connection", connectionId: "conn-1", language: "en" });
  });

  test("host default that cannot take audio falls back to WAV, then to Whistle, and stays there", async () => {
    const unsupported = new Error("STT_AUDIO_UNSUPPORTED: Web Speech requires microphone capture");
    const { ctx, calls } = fakeCtx({ fail: ({ options }) => (options.provider ? null : unsupported) });
    const t = createTranscriber(ctx, () => "");
    const first = t.transcribe(burst(1600));
    await tick();
    expect(calls[0]!.options.provider).toBe("whistle");
    expect(samplesOf(calls[0]!.audio).length).toBe(1600);
    calls[0]!.resolve("ok");
    await first;
    void t.transcribe(burst(1600));
    expect(calls[1]!.options.provider).toBe("whistle");
  });

  test("host default connection gets a WAV blob after it rejects PCM", async () => {
    const { ctx, calls } = fakeCtx({
      fail: ({ audio }) => (audio instanceof Blob ? null : new Error("STT_AUDIO_UNSUPPORTED: STT connections require an audio Blob")),
    });
    void createTranscriber(ctx, () => "").transcribe(burst(1600));
    await tick();
    expect(calls[0]!.audio).toBeInstanceOf(Blob);
    expect(calls[0]!.options.provider).toBeUndefined();
  });

  test("asks for keywords and words when the host has speech-to-text-options-v1", () => {
    const { ctx, calls } = fakeCtx({ capabilities: { "speech-to-text-options-v1": 1 } });
    void createTranscriber(ctx, () => "", () => ["Seo-yeon"]).transcribe(burst(1600));
    expect(calls[0]!.options).toMatchObject({ keywords: ["Lumi", "Seo-yeon"], words: true });
  });

  test("other errors reject the caller and free the queue", async () => {
    const { ctx } = fakeCtx({ fail: () => new Error("boom") });
    const t = createTranscriber(ctx, () => "");
    await expect(t.transcribe(burst(1600))).rejects.toThrow("boom");
    await expect(t.transcribe(burst(1600))).rejects.toThrow("boom");
  });

  test("no ctx.stt is a clear error", async () => {
    const t = createTranscriber({ host: { capabilities: {} } } as unknown as FrontendCtx, () => "");
    await expect(t.transcribe(burst(1600))).rejects.toThrow(/Speech-to-text is not available/);
  });
});

test("keywordList trims, dedupes and keeps the host limits", () => {
  const names = [" Seo-yeon ", "Seo-yeon", "Lumi", "Line\nbreak", "x".repeat(101), "", ...Array.from({ length: 600 }, (_, i) => `n${i}`)];
  const list = keywordList(names);
  expect(list.slice(0, 3)).toEqual(["Lumi", "Seo-yeon", "Line break"]);
  expect(list.length).toBe(500);
});

test("cleanTranscript strips double quotes and fixes ALL-CAPS sentences", () => {
  expect(cleanTranscript('She smiles. "You came back," she says. “Yes.”')).toBe("She smiles. You came back, she says. Yes.");
  expect(cleanTranscript("HAY LUMY OPEN THE PRESETS.")).toBe("Hay lumy open the presets.");
  expect(cleanTranscript("O.K. Close the drier. I THINK I SAW IT")).toBe("O.K. Close the drier. I think I saw it");
});
