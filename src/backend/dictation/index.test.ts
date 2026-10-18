import { describe, expect, test } from "bun:test";
import type { DictateRequest, DictationFormat } from "../../shared/protocol";
import { chunkUnits, formatDictation, rewriteDraft } from "./index";
import { segUnits, tokens } from "./segment";
import { scriptedServices } from "./test-services";

const FORMAT: DictationFormat = { thought: "asterisks", quotes: "straight", ooc: "double_parens" };
const SETTINGS = { decisionProfile: "", llmProfile: "", embeddingProfile: "" };
const req = (text: string, format = FORMAT): DictateRequest => ({ text, format, settings: SETTINGS });

const label = (u: string) => (/ooc|skip/i.test(u) ? "ooc" : /^(thanks|hello|is anyone)/i.test(u) ? "dialogue" : "narration");

describe("formatDictation, punctuated", () => {
  test("one Jev request labels units; code formats", async () => {
    const { services, calls } = scriptedServices({ label });
    const r = await formatDictation(req("I nod. Thanks, I say. Uh, OOC, can we skip to night?"), services);
    expect(r.text).toBe('I nod. "Thanks," I say.\n\n((Uh, OOC, can we skip to night?))');
    expect(r.punctuation).toBe("stt");
    expect(calls.decide).toHaveLength(1);
    expect(calls.complete).toHaveLength(0);
    expect(r.units.map((u) => u.label)).toEqual(["narration", "dialogue", "narration", "ooc", "ooc"]);
    expect(r.units.map((u) => u.paragraphStart)).toEqual([true, false, false, true, false]);
  });

  test("the output keeps the input's words for random transcripts", async () => {
    const vocab = ["I", "say", "OOC", "uh", '"hi"', "*wave*", "she", "whispers", "GO", "NOW", "RIGHT", "I'm", "don't", "think", "well,", "door."];
    const labels = ["narration", "dialogue", "thought", "ooc"] as const;
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    for (let k = 0; k < 200; k++) {
      const text = Array.from({ length: 1 + rand(40) }, () => vocab[rand(vocab.length)]).join(" ") + ".";
      const { services } = scriptedServices({ label: () => labels[rand(4)]!, paragraph: () => rand(2), speaker: () => rand(2) });
      const r = await formatDictation(req(text, k % 2 ? FORMAT : { thought: "plain", quotes: "curly", ooc: "brackets" }), services);
      expect(tokens(r.text)).toEqual(tokens(text));
    }
  });

  test("long dictations are split into requests of at most 500 words", async () => {
    const text = Array.from({ length: 120 }, (_, i) => `I take step number ${i} and look at the door.`).join(" ");
    const { services, calls } = scriptedServices();
    const r = await formatDictation(req(text), services);
    expect(calls.decide.length).toBe(3);
    for (const q of calls.decide) {
      const words = Object.values(q).filter((x) => x.type === "choice").reduce((s, x) => s + tokens((x.instructions as { unit: string }).unit).length, 0);
      expect(words).toBeLessThanOrEqual(500);
    }
    expect(tokens(r.text)).toEqual(tokens(text));
  });
});

test("chunkUnits keeps sentences whole", () => {
  const chunks = chunkUnits(segUnits("A b c, d e. F g h. I j."), 5);
  expect(chunks.map((c) => c.map((u) => u.text))).toEqual([["A b c,", "d e."], ["F g h.", "I j."]]);
});

describe("formatDictation, unpunctuated", () => {
  const raw = "i nod thanks i say ooc can we skip to night";

  test("an LLM punctuation pass that keeps the words feeds J", async () => {
    const { services, calls } = scriptedServices({ label, replies: ['I nod. "Thanks," I say. OOC, can we skip to night?'] });
    const r = await formatDictation(req(raw), services);
    expect(r.punctuation).toBe("llm");
    expect(r.text).toBe('I nod. "Thanks," I say.\n\n((OOC, can we skip to night?))');
    expect(calls.decide).toHaveLength(1);
  });

  test("changed words or a failed pass fall back to Jev gap questions", async () => {
    const gap = (t: string) => (/(nod|thanks|i say) \| /.test(t) ? 0.9 : 0);
    for (const reply of ["I nod. Thanks, I said. OOC, can we skip to night?", new Error("down")]) {
      const { services, calls } = scriptedServices({ label, gap, replies: [reply] });
      const r = await formatDictation(req(raw), services);
      expect(r.punctuation).toBe("jev_gaps");
      expect(calls.decide).toHaveLength(2);
      expect(r.text).toBe('i nod "thanks" i say\n\n((ooc can we skip to night))');
    }
  });
});

test("rewriteDraft sends the draft with recent messages as context and returns the text", async () => {
  const { services, calls } = scriptedServices({ replies: ['  I nod slowly. "Thanks," I say.\n'] });
  const out = await rewriteDraft('I nod. "Thanks."', [{ role: "assistant", content: "She hands you the map." }], services);
  expect(out).toBe('I nod slowly. "Thanks," I say.');
  const user = calls.complete[0]![1]!.content;
  expect(user).toContain("She hands you the map.");
  expect(user).toContain('I nod. "Thanks."');
});

test("rewriteDraft in dictation mode uses the dictation prompt and the text already written", async () => {
  const { services, calls } = scriptedServices({ replies: ["I lean on the railing."] });
  await rewriteDraft("lean on the rayling", [{ role: "assistant", content: "The ship's railing is wet." }], services, { mode: "dictation", before: "I sigh." });
  const [system, user] = calls.complete[0]!;
  expect(system!.content).toContain("may expand");
  expect(user!.content).toContain("Already written in this message (keep, do not repeat):\nI sigh.");
  expect(user!.content).toContain("Dictation:\nlean on the rayling");
});
