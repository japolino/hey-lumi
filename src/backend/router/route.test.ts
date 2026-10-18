import { describe, expect, test } from "bun:test";
import { fakeServices, noul, pick, request } from "./fake-services";
import { validatePlan } from "./planner";
import { stripDictationPrefix, THRESHOLDS } from "./route";
import { routeUtterance } from "./index";

const command = pick({ command: 0.95, dictation: 0.05 });

describe("routeUtterance", () => {
  test("runs a confident action with its argument and says what it does", async () => {
    const { services, decided } = fakeServices({
      answers: { intent: command, action: pick({ "Switch connection profile": 0.9, none: 0.1 }), arg_llm_profile: pick({ "Claude Sonnet": 0.55, unclear: 0.45 }) },
    });
    const result = await routeUtterance(request("switch to claw"), services);
    expect(result).toEqual({ kind: "run", steps: [{ actionId: "lumi:llm_switch", args: { llm_profile: "l1" } }], say: "Switching to Claude Sonnet", confirm: false, confidence: 0.55 });
    expect(decided.length).toBe(1);
  });

  test("asks when the argument is unclear or tied with another name", async () => {
    const { services } = fakeServices({
      answers: { intent: command, action: pick({ "Switch connection profile": 1 }), arg_llm_profile: pick({ "Gemini Pro": 0.75, unclear: 0.2, "Gemini Flash": 0.05 }) },
    });
    const result = await routeUtterance(request("switch to gemini"), services);
    expect(result.kind).toBe("ask");
    if (result.kind !== "ask") return;
    expect(result.pending.question).toBe("Did you mean Gemini Pro or Gemini Flash?");
    expect(result.pending.options.map((o) => o.step.args.llm_profile)).toEqual(["l3", "l2"]);
  });

  test("asks between likely actions when the action is unsure", async () => {
    const { services } = fakeServices({
      answers: { intent: command, action: pick({ Theme: 0.4, "Voice & Speech": 0.35, none: 0.25 }) },
    });
    const result = await routeUtterance(request("open the thing"), services);
    expect(result).toMatchObject({ kind: "ask", pending: { question: "Did you mean Theme or Voice & Speech?" } });
  });

  test("confirms destructive actions", async () => {
    const { services } = fakeServices({ answers: { intent: command, action: pick({ "Delete Chat": 0.99 }) } });
    expect(await routeUtterance(request("delete this chat"), services)).toMatchObject({ kind: "run", confirm: true, say: "Delete Chat" });
  });

  test("closes, ignores and dictates by intent", async () => {
    const run = async (utterance: string, intent: Record<string, number>) =>
      routeUtterance(request(utterance), fakeServices({ answers: { intent: pick(intent) } }).services);
    expect(await run("that's about it", { close: 0.95 })).toEqual({ kind: "close" });
    expect(await run("that's about it", { close: THRESHOLDS.close - 0.1, command: 0.05 })).toEqual({ kind: "ignore" });
    expect(await run("Mom, one minute", { not_for_lumi: 0.9 })).toEqual({ kind: "ignore" });
    expect(await run("Lumi, write: She smiles.", { dictation: 0.9 })).toEqual({ kind: "dictation", text: "She smiles." });
    expect(await run("type ooc skip ahead", { command: 0.45, dictation: 0.4 })).toEqual({ kind: "dictation", text: "ooc skip ahead" });
  });

  test("runs the picked pending option, and routes normally when the answer picks none", async () => {
    const pending = {
      question: "Did you mean Seo-yeon or Seo-ah?",
      options: [
        { label: "Seo-yeon", step: { actionId: "lumi:character_open", args: { character: "c1" } } },
        { label: "Seo-ah", step: { actionId: "lumi:character_open", args: { character: "c2" } } },
      ],
    };
    const picked = fakeServices({ answers: { pending: pick({ "Seo-ah": 0.9, "none of these": 0.1 }) } });
    expect(await routeUtterance(request("the second one", { pending }), picked.services)).toMatchObject({
      kind: "run",
      steps: [pending.options[1]!.step],
      say: "Opening Seo-ah",
    });
    const other = fakeServices({ answers: { pending: pick({ "none of these": 0.95 }), intent: command, action: pick({ Theme: 0.9 }) } });
    expect(await routeUtterance(request("open my themes instead", { pending }), other.services)).toMatchObject({
      kind: "run",
      steps: [{ actionId: "surface:drawer_tab:theme" }],
    });
  });

  test("plans multi-step requests with the LLM and validates the plan", async () => {
    const plan = '```json\n[{"actionId":"surface:drawer_tab:lorebook","args":{}},{"actionId":"lumi:persona_switch","args":{"persona":"eve"}}]\n```';
    const { services, completed } = fakeServices({ answers: { intent: command, multi: noul(0.95) }, plan });
    const result = await routeUtterance(request("open the lorebook and switch my persona to Eve"), services);
    expect(result).toMatchObject({
      kind: "run",
      steps: [{ actionId: "surface:drawer_tab:lorebook" }, { actionId: "lumi:persona_switch", args: { persona: "p2" } }],
      say: "Opening Lorebook, then switching persona to Eve",
    });
    expect(completed.length).toBe(1);
  });

  test("says so when the planner finds nothing valid", async () => {
    const { services } = fakeServices({ answers: { intent: command, action: pick({ none: 0.9 }) }, plan: '[{"actionId":"surface:command:make-coffee","args":{}}]' });
    expect((await routeUtterance(request("make me a coffee"), services)).kind).toBe("none");
  });
});

describe("validatePlan", () => {
  const req = request("");
  test("resolves misheard names and rejects unknown actions or missing arguments", () => {
    expect(validatePlan('[{"actionId":"lumi:llm_switch","args":{"llm_profile":"claw sonnet"}}]', req.candidates, req.entities)).toEqual([
      { actionId: "lumi:llm_switch", args: { llm_profile: "l1" } },
    ]);
    expect(validatePlan('[{"actionId":"lumi:llm_switch","args":{}}]', req.candidates, req.entities)).toBeNull();
    expect(validatePlan('[{"actionId":"lumi:llm_switch","args":{"llm_profile":"Mistral Large"}}]', req.candidates, req.entities)).toBeNull();
    expect(validatePlan('[{"actionId":"lumi:fly"}]', req.candidates, req.entities)).toBeNull();
    expect(validatePlan("I can't do that", req.candidates, req.entities)).toBeNull();
    expect(validatePlan("[]", req.candidates, req.entities)).toBeNull();
  });
});

test("stripDictationPrefix keeps the words after the prefix unchanged", () => {
  expect(stripDictationPrefix("write I walk to the window")).toBe("I walk to the window");
  expect(stripDictationPrefix("Hey Lumi, type: \"Hi,\" she says.")).toBe("\"Hi,\" she says.");
  expect(stripDictationPrefix("She writes a letter.")).toBe("She writes a letter.");
  expect(stripDictationPrefix("Typewriters are loud.")).toBe("Typewriters are loud.");
});
