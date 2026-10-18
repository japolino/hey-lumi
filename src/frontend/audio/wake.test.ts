import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AudioSource, SpeechBurst, Transcriber } from "./types";
import { createTextWakeDetector, matchWake } from "./wake";

/** Local eval data (scratch/ is not in git); these tests skip without it. */
const WHISTLE = new URL("../../../scratch/audio/wh_all.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Ground truth of the clips in scratch/audio (spec/audio-feasibility.md section 4). */
function label(path: string): "pos" | "neg" | "noisy_pos" | "noisy_neg" {
  const name = path.replace(/^.*\/clips\//, "");
  if (name.startsWith("noisy/")) return `noisy_${label("/clips/" + name.slice(6).replace(/^pos_/, "edge/pos_"))}` as "noisy_pos";
  if (name.startsWith("edge/pos_")) return "pos";
  const sapi = /^wake_\d+_\d+_(\d)\.wav$/.exec(name);
  if (sapi) return "014".includes(sapi[1]!) ? "pos" : "neg";
  return ["cmd1.wav", "cmd2.wav", "wake_only.wav"].includes(name) ? "pos" : "neg";
}

describe.skipIf(!existsSync(WHISTLE))("matchWake on real Whistle output", () => {
  const rows = (existsSync(WHISTLE) ? JSON.parse(readFileSync(WHISTLE, "utf8")) : []) as Array<{ name: string; plain: { text?: string } }>;
  const counts = { pos: 0, neg: 0, noisy_pos: 0, noisy_neg: 0 };
  const hits = { pos: 0, neg: 0, noisy_pos: 0, noisy_neg: 0 };
  for (const row of rows) {
    const l = label(row.name);
    counts[l]++;
    if (matchWake(row.plain.text ?? "")) hits[l]++;
  }

  test("finds the wake word in clean clips and never in negatives", () => {
    expect(counts).toEqual({ pos: 87, neg: 134, noisy_pos: 87, noisy_neg: 0 });
    expect(hits.pos).toBeGreaterThanOrEqual(77);
    expect(hits.neg).toBe(0);
    expect(hits.noisy_pos).toBeGreaterThanOrEqual(54);
  });
});

describe("matchWake", () => {
  test.each([
    ["Hey, Lumi.", ""],
    ['"Hey, Lumi, open the character list."', 'open the character list."'],
    ["HAY LUMY Switch the connection profile.", "Switch the connection profile."],
    ["hey loomy... go to settings", "go to settings"],
    ["Hey, looming.", ""],
  ])("%s", (text, rest) => expect(matchWake(text)).toEqual({ rest }));

  test.each(["Hey, Louis!", "Hey Louie, come here.", "Hey, Lucy, can you pass the salt?", "Hey, Lou, me and you are late.", "Okay, Lumi, close it.", "I told Lumi about it.", "Hey Lumiverse is great", "They lumi"])(
    "%s is not a wake word",
    (text) => expect(matchWake(text)).toBeNull(),
  );
});

describe("createTextWakeDetector", () => {
  function setup(texts: string[]) {
    const seen: number[] = [];
    const transcriber: Transcriber = {
      transcribe: async (b) => (seen.push(b.durationMs), { text: texts.shift() ?? "" }),
    };
    let emit!: (b: SpeechBurst) => void;
    const source = { onBurst: (fn: (b: SpeechBurst) => void) => ((emit = fn), () => {}) } as unknown as AudioSource;
    const wakes: string[] = [];
    void createTextWakeDetector(transcriber).start(source, (hit) => wakes.push(hit.rest));
    const burst = (ms: number): SpeechBurst => ({ samples: new Float32Array(ms * 16), sampleRate: 16000, durationMs: ms, endedAt: 0 });
    return { seen, wakes, send: (ms: number) => emit(burst(ms)) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("a short burst is transcribed once", async () => {
    const s = setup(["Hey Lumi, open themes."]);
    s.send(2000);
    await settle();
    expect(s.seen).toEqual([2000]);
    expect(s.wakes).toEqual(["open themes."]);
  });

  test("a long burst: the first 3 s for the match, then the whole burst for the rest", async () => {
    const s = setup(["Hey Lumi, switch the", "Hey Lumi, switch the connection profile to Claude."]);
    s.send(7000);
    await settle();
    expect(s.seen).toEqual([3000, 7000]);
    expect(s.wakes).toEqual(["switch the connection profile to Claude."]);
  });

  test("no match: no wake and no second request", async () => {
    const s = setup(["She leans against the door."]);
    s.send(7000);
    await settle();
    expect(s.seen).toEqual([3000]);
    expect(s.wakes).toEqual([]);
  });
});
