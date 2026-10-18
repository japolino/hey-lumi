import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { FrontendCtx } from "../../shared/host-ext";
import { HOST_MIC_SELECTOR, watchPauseGates } from "./gates";
import type { MicCapture } from "./types";

const win = new Window();
const globals = { document: win.document, HTMLMediaElement: win.HTMLMediaElement, MutationObserver: win.MutationObserver };
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(globals)) (saved[k] = (globalThis as any)[k]), ((globalThis as any)[k] = v);
});
afterAll(() => {
  for (const k of Object.keys(globals)) (globalThis as any)[k] = saved[k];
  void win.happyDOM.close();
});

function fakeCapture() {
  const reasons = new Set<string>();
  return {
    reasons,
    capture: { setPaused: (r: string, on: boolean) => void (on ? reasons.add(r) : reasons.delete(r)) } as unknown as MicCapture,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("watchPauseGates without host APIs", () => {
  test("pauses while an audible <audio> plays (non-bubbling media events)", async () => {
    const { reasons, capture } = fakeCapture();
    const stop = watchPauseGates({ host: { capabilities: {} } } as unknown as FrontendCtx, capture);
    const wrapper = win.document.createElement("div");
    const audio = win.document.createElement("audio");
    wrapper.appendChild(audio);
    win.document.body.appendChild(wrapper);

    await audio.play();
    expect(reasons.has("tts")).toBe(true);
    audio.pause();
    expect(reasons.has("tts")).toBe(false);

    audio.muted = true;
    await audio.play();
    expect(reasons.has("tts")).toBe(false);
    audio.pause();
    stop();
    wrapper.remove();
  });

  test("pauses while the host recording panel is in the DOM", async () => {
    const { reasons, capture } = fakeCapture();
    const stop = watchPauseGates({ host: { capabilities: {} } } as unknown as FrontendCtx, capture);
    const panel = win.document.createElement("button");
    panel.setAttribute("aria-live", "polite");
    win.document.body.appendChild(panel);
    await flush();
    expect(win.document.querySelector(HOST_MIC_SELECTOR)).toBe(panel);
    expect(reasons.has("host_mic")).toBe(true);
    panel.remove();
    await flush();
    expect(reasons.has("host_mic")).toBe(false);
    stop();
  });
});

test("uses ctx.tts and ctx.stt.onHostActivity when the host has them", () => {
  const listeners: Record<string, (on: boolean) => void> = {};
  let unsubscribed = 0;
  const ctx = {
    host: { capabilities: { "text-to-speech-v1": 1 } },
    tts: { subscribe: (fn: (on: boolean) => void) => ((listeners.tts = fn), () => unsubscribed++), isSpeaking: () => true },
    stt: { onHostActivity: (fn: (on: boolean) => void) => ((listeners.mic = fn), () => unsubscribed++), isHostCapturing: () => false },
  } as unknown as FrontendCtx;
  const { reasons, capture } = fakeCapture();
  const stop = watchPauseGates(ctx, capture);
  expect([...reasons]).toEqual(["tts"]);
  listeners.tts!(false);
  listeners.mic!(true);
  expect([...reasons]).toEqual(["host_mic"]);
  listeners.tts!(true);
  stop();
  expect(unsubscribed).toBe(2);
  expect(reasons.size).toBe(0);
});
