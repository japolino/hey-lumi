import { expect, test } from "bun:test";
import type { AudioSource, WakeDetector } from "./types";
import { createWakeSelector, type WakeStatus } from "./wake-select";

const source = {} as AudioSource;

function fake(name: string, log: string[], startResult: () => Promise<void> = async () => {}): WakeDetector {
  return {
    start: async () => {
      log.push(`${name}.start`);
      await startResult();
    },
    stop: () => void log.push(`${name}.stop`),
  };
}

test("the text match listens while the spotter loads, then hands over", async () => {
  const log: string[] = [];
  const statuses: WakeStatus[] = [];
  let release!: () => void;
  const kwsReady = new Promise<void>((r) => (release = r));
  const wake = createWakeSelector({ kws: () => fake("kws", log, () => kwsReady), text: fake("text", log), onStatus: (s) => statuses.push(s), hasWasm: true });
  await wake.start(source, () => {});
  expect(log).toEqual(["text.start", "kws.start"]);
  release();
  await Bun.sleep(0);
  expect(log).toEqual(["text.start", "kws.start", "text.stop"]);
  expect(statuses.at(-1)).toEqual({ detector: "kws", state: "ready" });
  wake.stop();
  await wake.start(source, () => {});
  expect(log.slice(-2)).toEqual(["kws.stop", "kws.start"]);
});

test("a failed spotter leaves the text match on; no WebAssembly never tries it", async () => {
  const log: string[] = [];
  const statuses: WakeStatus[] = [];
  const wake = createWakeSelector({ kws: () => fake("kws", log, async () => { throw new Error("download failed"); }), text: fake("text", log), onStatus: (s) => statuses.push(s), hasWasm: true });
  await wake.start(source, () => {});
  await Bun.sleep(0);
  expect(statuses.at(-1)).toEqual({ detector: "text", state: "kws_failed", error: "download failed" });
  expect(log).not.toContain("text.stop");

  const log2: string[] = [];
  const noWasm = createWakeSelector({ kws: () => fake("kws", log2), text: fake("text", log2), onStatus: () => {}, hasWasm: false });
  await noWasm.start(source, () => {});
  expect(log2).toEqual(["text.start"]);
});

test("a session that opens while the spotter loads keeps it stopped", async () => {
  const log: string[] = [];
  let release!: () => void;
  const kwsReady = new Promise<void>((r) => (release = r));
  const wake = createWakeSelector({ kws: () => fake("kws", log, () => kwsReady), text: fake("text", log), onStatus: () => {}, hasWasm: true });
  await wake.start(source, () => {});
  wake.stop();
  release();
  await Bun.sleep(0);
  expect(log.at(-1)).toBe("kws.stop");
});
