import { expect, test } from "bun:test";
import type { DictationLabel } from "../../shared/protocol";
import { applyRules } from "./rules";
import { mergeFillers, segUnits } from "./segment";

const run = (text: string, labels: DictationLabel[]) => applyRules(mergeFillers(segUnits(text)), labels);

test("a bare say or think tag is narration", () => {
  expect(run("Listen, I say. I know.", ["dialogue", "dialogue", "dialogue"])).toEqual(["dialogue", "narration", "dialogue"]);
});

test("dialogue in the same sentence before a think tag becomes thought", () => {
  expect(run("Great, just great, I think. Well, we walk.", ["dialogue", "dialogue", "dialogue", "dialogue", "narration"])).toEqual([
    "thought", "thought", "narration", "dialogue", "narration",
  ]);
  expect(run("He lies. Oh, he lies, I'm thinking.", ["dialogue", "dialogue", "dialogue"])).toEqual(["dialogue", "thought", "narration"]);
});

test("a short unit inside one sentence between two same labels takes that label", () => {
  expect(run("I run to the door, fast, and pull it open.", ["narration", "dialogue", "narration"])).toEqual([
    "narration", "narration", "narration",
  ]);
  expect(run("I run to the door. Fast. And pull it open.", ["narration", "dialogue", "narration"])).toEqual([
    "narration", "dialogue", "narration",
  ]);
});
