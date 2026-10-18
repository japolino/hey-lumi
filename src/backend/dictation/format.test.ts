import { expect, test } from "bun:test";
import type { DictationFormat, DictationLabel } from "../../shared/protocol";
import { paragraphStarts, render, speakerStarts } from "./format";
import { segUnits } from "./segment";

const DEFAULT: DictationFormat = { thought: "asterisks", quotes: "straight", ooc: "double_parens" };
const units = segUnits("I nod. Thanks, I say. Okay, don't panic, OOC, can we skip to night?");
const labels: DictationLabel[] = ["narration", "dialogue", "narration", "thought", "thought", "ooc", "ooc"];

test("formats runs and puts OOC in its own paragraph", () => {
  const paras = paragraphStarts(labels, new Map());
  expect(render(units, labels, paras, new Set(), DEFAULT)).toBe(
    'I nod. "Thanks," I say. *Okay, don\'t panic*,\n\n((OOC, can we skip to night?))',
  );
});

test("format options: plain thoughts, curly quotes, brackets", () => {
  const paras = paragraphStarts(labels, new Map());
  expect(render(units, labels, paras, new Set(), { thought: "plain", quotes: "curly", ooc: "brackets" })).toBe(
    "I nod. \u201cThanks,\u201d I say. Okay, don't panic,\n\n[OOC, can we skip to night?]",
  );
});

test("paragraph nouls above the threshold break; OOC edges always break", () => {
  const us = segUnits("I sit. Later, I wake.");
  const ls: DictationLabel[] = ["narration", "narration", "narration"];
  expect(render(us, ls, paragraphStarts(ls, new Map([[1, 0.6]])), new Set(), DEFAULT)).toBe("I sit.\n\nLater, I wake.");
  expect(render(us, ls, paragraphStarts(ls, new Map([[1, 0.3]])), new Set(), DEFAULT)).toBe("I sit. Later, I wake.");
});

test("a speaker change inside dialogue closes and reopens the quotes", () => {
  const us = segUnits("Captain wants an update. Tell him later, Hail says.");
  const ls: DictationLabel[] = ["dialogue", "dialogue", "narration"];
  const speakers = speakerStarts(ls, new Map([[1, 0.9]]));
  expect(render(us, ls, new Set(), speakers, DEFAULT)).toBe('"Captain wants an update." "Tell him later," Hail says.');
  expect(speakerStarts(["narration", "dialogue"], new Map([[1, 0.9]])).size).toBe(0);
});
