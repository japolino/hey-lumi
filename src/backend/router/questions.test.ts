import { describe, expect, test } from "bun:test";
import type { ArgKind } from "../../shared/protocol";
import { fakeServices, lumiCandidates, request, surfaceCandidates, testEntities } from "./fake-services";
import { narrowEntities } from "./narrow";
import { buildDecision, IMAGE_LIMIT, type Ranked } from "./questions";

const ranked = (utterance: string, kinds: Partial<Record<ArgKind, typeof testEntities.character>> = testEntities) =>
  Object.fromEntries(Object.entries(kinds).map(([k, list]) => [k, narrowEntities(utterance, list!)])) as Partial<Record<ArgKind, Ranked[]>>;

const criteriaKeys = (q: unknown) => Object.keys((q as { criteria: Record<string, unknown> }).criteria);

describe("buildDecision", () => {
  test("puts the safe option first in every choice", async () => {
    const { services } = fakeServices();
    const req = request("open my themes");
    const plan = await buildDecision(req, req.candidates, ranked(req.utterance), services);
    const q = plan.input.questions;
    expect(criteriaKeys(q.intent)).toEqual(["close", "command", "dictation", "not_for_lumi"]);
    expect(criteriaKeys(q.action)[0]).toBe("none");
    expect(criteriaKeys(q.arg_character)[0]).toBe("unclear");
    expect(q.multi!.type).toBe("noul");
    expect(plan.pending).toBeUndefined();
  });

  test("asks for an argument kind only when a candidate needs it and entities exist", async () => {
    const { services } = fakeServices();
    const candidates = [...surfaceCandidates, ...lumiCandidates.filter((c) => c.id !== "lumi:persona_switch")];
    const plan = await buildDecision(request("x"), candidates, ranked("x"), services);
    expect(Object.keys(plan.input.questions).filter((k) => k.startsWith("arg_")).sort()).toEqual(["arg_character", "arg_llm_profile"]);
  });

  test("maps duplicate labels to distinct option keys", async () => {
    const { services } = fakeServices();
    const plan = await buildDecision(request("theme"), surfaceCandidates, {}, services);
    expect([...plan.actions.keys()].filter((k) => k.startsWith("Theme"))).toEqual(["Theme", "Theme (2)"]);
  });

  test("adds the pending question with 'none of these' first", async () => {
    const { services } = fakeServices();
    const pending = { question: "Did you mean Seo-yeon or Seo-ah?", options: [{ label: "Seo-yeon", step: { actionId: "lumi:character_open", args: { character: "c1" } } }] };
    const plan = await buildDecision(request("the first", { pending }), lumiCandidates, {}, services);
    expect(criteriaKeys(plan.input.questions.pending)).toEqual(["none of these", "Seo-yeon"]);
  });
});

describe("character portraits", () => {
  const characters = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Hero ${i}`, imageId: `img${i}` }));
  const build = async (utterance: string, options: Parameters<typeof fakeServices>[0]) => {
    const { services } = fakeServices(options);
    return buildDecision(request(utterance), lumiCandidates, ranked(utterance, { character: characters }), services);
  };

  test("go to Jev as image options when the user describes looks", async () => {
    const plan = await build("open the one with red hair", { decisionImages: true });
    const refs = Object.keys(plan.input.assets ?? {});
    expect(refs.length).toBe(IMAGE_LIMIT);
    expect(criteriaKeys(plan.input.questions.arg_character).length).toBe(IMAGE_LIMIT + 1);
    const criteria = JSON.stringify(plan.input.questions.arg_character);
    for (const ref of refs) expect(criteria).toContain(ref);
    expect(plan.input.assets![refs[0]!]).toEqual({ image_id: "img0" });
  });

  test("stay text when images are off, the size is out of range, or the name was said clearly", async () => {
    expect((await build("open the one with red hair", { decisionImages: false })).input.assets).toBeUndefined();
    expect((await build("open the one with red hair", { decisionImages: true, portraitSize: { width: 200, height: 512 } })).input.assets).toBeUndefined();
    expect((await build("open the one with red hair", { decisionImages: true, portraitSize: null })).input.assets).toBeUndefined();
    expect((await build("open hero", { decisionImages: true })).input.assets).toBeUndefined();
    expect((await build("can you open my heroics", { decisionImages: true })).input.assets).toBeUndefined();
  });
});
