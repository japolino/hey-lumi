import { expect, test } from "bun:test";
import type { DomControl } from "../../shared/protocol";
import { fakeServices, pick } from "./fake-services";
import { pickDomControl } from "./index";

const controls: DomControl[] = [
  { id: "0", label: "Settings", role: "button", context: "Preset", destructiveLooking: false },
  { id: "1", label: "Settings", role: "button", context: "Top bar", destructiveLooking: false },
];
const settings = { decisionProfile: "", llmProfile: "", embeddingProfile: "" };

test("pickDomControl offers 'none' first and maps the pick back to the control id", async () => {
  const { services, decided } = fakeServices({ answers: { pick: pick({ "Settings (2)": 0.9, none: 0.1 }) } });
  expect(await pickDomControl({ utterance: "open the top settings", controls, settings }, services)).toEqual({ controlId: "1", confidence: 0.9 });
  expect(Object.keys((decided[0]!.questions.pick as { criteria: object }).criteria)).toEqual(["none", "Settings", "Settings (2)"]);
});

test("pickDomControl returns null for 'none' or a weak pick", async () => {
  const weak = fakeServices({ answers: { pick: pick({ Settings: 0.3, "Settings (2)": 0.3, none: 0.4 }) } });
  expect((await pickDomControl({ utterance: "order pizza", controls, settings }, weak.services)).controlId).toBeNull();
  const low = fakeServices({ answers: { pick: pick({ Settings: 0.35, "Settings (2)": 0.33, none: 0.32 }) } });
  expect((await pickDomControl({ utterance: "settings", controls, settings }, low.services)).controlId).toBeNull();
});
