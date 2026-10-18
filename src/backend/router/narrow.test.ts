import { describe, expect, test } from "bun:test";
import type { ActionCandidate } from "../../shared/protocol";
import { fakeServices, lumiCandidates, surfaceCandidates, testEntities } from "./fake-services";
import { wordSimilarity } from "./fuzzy";
import { narrowCandidates, narrowEntities } from "./narrow";

const filler: ActionCandidate[] = Array.from({ length: 60 }, (_, i) => ({ id: `surface:settings_tab:x${i}`, label: `Option ${i}`, description: `Setting number ${i}` }));

describe("fuzzy matching", () => {
  test("survives speech-to-text slips", () => {
    expect(wordSimilarity("claw", "claude")).toBeGreaterThanOrEqual(0.5);
    expect(wordSimilarity("kaylin", "kaelen")).toBeGreaterThanOrEqual(0.5);
    expect(wordSimilarity("theme", "voice")).toBe(0);
  });

  test("ranks entities by spoken name", () => {
    expect(narrowEntities("switch to claw", testEntities.llm_profile)[0]!.item.name).toBe("Claude Sonnet");
    expect(narrowEntities("new chat with seo yeon", testEntities.character)[0]!.item.name).toBe("Seo-yeon");
    expect(narrowEntities("open seo ah", testEntities.character)[0]!.item.name).toBe("Seo-ah");
  });
});

describe("narrowCandidates", () => {
  const all = [...filler, ...surfaceCandidates, ...lumiCandidates];

  test("keeps every Lumi action, the best surface match first, within the limit, without duplicates", async () => {
    const { services } = fakeServices();
    const out = await narrowCandidates("go to the lore book", all, services, 30);
    expect(out.length).toBe(30);
    expect(out[0]!.id).toBe("surface:drawer_tab:lorebook");
    for (const c of lumiCandidates) expect(out).toContain(c);
    const themes = await narrowCandidates("open my themes", all, services, 30);
    expect(themes.filter((c) => c.label === "Theme").length).toBe(1);
  });

  test("adds embedding matches and caches passage vectors", async () => {
    const calls: Array<[number, string]> = [];
    const embed = async (texts: string[], type: "query" | "passage") => {
      calls.push([texts.length, type]);
      // The query vector points at Voice & Speech only.
      return { cacheKey: "test-model", vectors: texts.map((t) => (type === "query" || t.startsWith("Voice") ? [1, 0] : [0, 1])) };
    };
    const { services } = fakeServices({ embed });
    const out = await narrowCandidates("I want her to talk out loud", [...filler, ...surfaceCandidates], services, 3);
    expect(out.map((c) => c.id)).toContain("surface:settings_tab:voice");
    await narrowCandidates("something else", [...filler, ...surfaceCandidates], services, 3);
    expect(calls.filter(([, type]) => type === "passage").length).toBe(1);
  });
});
