import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createBurstCutter, type BurstCutterOptions } from "./speech-activity";
import { encodeWav } from "./wav";

/** Local eval clips (scratch/ is not in git); these tests skip without them. */
const CLIPS = new URL("../../../scratch/audio/clips/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FRAME = 800;

/** Reads 16-bit PCM WAV (any channel count; the first channel is used). */
function decodeWav(bytes: ArrayBuffer): { samples: Float32Array; sampleRate: number } {
  const view = new DataView(bytes);
  let at = 12;
  let channels = 1;
  let sampleRate = 16000;
  while (at + 8 <= view.byteLength) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    const size = view.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
    } else if (id === "data") {
      const count = Math.floor(Math.min(size, view.byteLength - at - 8) / 2 / channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2 * channels, true) / 0x8000;
      return { samples, sampleRate };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

function cut(samples: Float32Array, options?: BurstCutterOptions) {
  const bursts: Float32Array[] = [];
  let starts = 0;
  const cutter = createBurstCutter((b) => bursts.push(b), () => starts++, options);
  const padded = new Float32Array(samples.length + 3 * 16000);
  padded.set(samples);
  for (let i = 0; i + FRAME <= padded.length; i += FRAME) cutter.push(padded.slice(i, i + FRAME));
  return { bursts, starts, secs: bursts.map((b) => b.length / 16000) };
}

const tone = (secs: number, amp = 0.2) => Float32Array.from({ length: secs * 16000 }, (_, i) => amp * Math.sin(i / 5));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const silence = (secs: number) => new Float32Array(secs * 16000);
const clip = (name: string) => decodeWav(readFileSync(CLIPS + name).buffer as ArrayBuffer).samples;

describe.skipIf(!existsSync(CLIPS))("burst cutter on real clips", () => {
  test.each([
    ["wake_only.wav", 0.6, 1.4],
    ["cmd1.wav", 2.0, 3.2],
    ["rp1.wav", 7.5, 9.2],
    ["long1.wav", 55, 58.1],
  ])("%s is one burst", (name, min, max) => {
    const { bursts, starts, secs } = cut(clip(name));
    expect(bursts.length).toBe(1);
    expect(starts).toBe(1);
    expect(secs[0]).toBeGreaterThan(min);
    expect(secs[0]).toBeLessThan(max);
  });

  test("two clips with a 2 s gap are two bursts, a 0.5 s gap is one", () => {
    const a = clip("wake_only.wav");
    const b = clip("cmd1.wav");
    expect(cut(join(a, silence(2), b)).bursts.length).toBe(2);
    expect(cut(join(a, silence(0.5), b)).bursts.length).toBe(1);
  });
});

describe("burst cutter", () => {
  test("keeps ~250 ms before the speech", () => {
    const { bursts } = cut(join(silence(1), tone(1)));
    const firstLoud = bursts[0]!.findIndex((s) => Math.abs(s) > 0.05);
    expect(firstLoud / 16000).toBeGreaterThanOrEqual(0.2);
    expect(firstLoud / 16000).toBeLessThanOrEqual(0.3);
  });

  test("drops clicks and bursts under 0.4 s of speech", () => {
    expect(cut(join(silence(1), tone(0.1), silence(1))).bursts.length).toBe(0);
    expect(cut(join(silence(1), tone(0.3), silence(1))).bursts.length).toBe(0);
    expect(cut(join(silence(1), tone(0.6), silence(1))).bursts.length).toBe(1);
  });

  test("caps long speech", () => {
    const { secs } = cut(tone(25), { maxBurstMs: 10_000 });
    expect(secs.slice(0, 2)).toEqual([10, 10]);
  });

  test("reset discards the burst in progress", () => {
    const bursts: Float32Array[] = [];
    const cutter = createBurstCutter((b) => bursts.push(b), () => {});
    const audio = join(tone(1), silence(2));
    for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
      if (i === 16000) cutter.reset();
      cutter.push(audio.slice(i, i + FRAME));
    }
    expect(bursts.length).toBe(0);
  });
});

test("encodeWav round trip", async () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
  const blob = encodeWav(samples, 16000);
  const back = decodeWav(await blob.arrayBuffer());
  expect(back.sampleRate).toBe(16000);
  expect(Array.from(back.samples).map((s) => Math.round(s * 100) / 100)).toEqual([0, 0.5, -0.5, 0.25]);
});
