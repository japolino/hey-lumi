import { describe, expect, test } from "bun:test";
import { cleanTranscript, isPunctuated, mergeFillers, segUnits, shiftGaps, unitsFromCuts } from "./segment";

const texts = (us: { text: string }[]) => us.map((u) => u.text);

describe("segUnits", () => {
  test("splits at sentence ends, commas and after tags with a subject", () => {
    const us = segUnits("Stay back, he warns. I won't ask twice. Nobody moves.");
    expect(texts(us)).toEqual(["Stay back,", "he warns.", "I won't ask twice.", "Nobody moves."]);
    expect(us.map((u) => u.sentStart)).toEqual([true, false, true, true]);
    expect(texts(segUnits("I say with a grin, hope that's fine."))).toEqual(["I say", "with a grin,", "hope that's fine."]);
  });
});

test("mergeFillers joins filler-only units into the next unit of the same sentence", () => {
  const us = mergeFillers(segUnits("Um, I, I grab the rope and, uh, start climbing. Uh, hi."));
  expect(texts(us)).toEqual(["Um, I,", "I grab the rope and,", "uh, start climbing.", "Uh, hi."]);
  expect(us[2]!.sentStart).toBe(false);
  expect(us[3]!.sentStart).toBe(true);
});

describe("cleanTranscript", () => {
  test("strips quote marks and asterisks", () => {
    expect(cleanTranscript('I say "hi" and *wave*  \u201cok\u201d')).toBe("I say hi and wave ok");
  });
  test("lowercases runs of all-caps words but keeps short caps and OOC", () => {
    expect(cleanTranscript("I YELL GET OUT OF HERE. OOC CAN WE STOP NOW")).toBe("I yell get out of here. OOC can we stop now");
    expect(cleanTranscript("OOC, the NPC is OK.")).toBe("OOC, the NPC is OK.");
  });
});

test("isPunctuated needs one sentence mark per 25 words", () => {
  expect(isPunctuated("i open the door")).toBe(false);
  expect(isPunctuated("I open the door.")).toBe(true);
  const long = Array.from({ length: 60 }, () => "word").join(" ");
  expect(isPunctuated(`${long}.`)).toBe(false);
  expect(isPunctuated(`${long}. a.`)).toBe(true);
});

test("gap cuts move back over words a sentence rarely ends on, then tags split", () => {
  const words = "so you're the new captain i cross my arms she says no".split(" ");
  const cuts = shiftGaps(words, new Map([[6, 0.9], [3, 0.1]]), 0.2);
  expect([...cuts]).toEqual([5]);
  expect(texts(unitsFromCuts(words, cuts))).toEqual(["so you're the new captain", "i cross my arms she says", "no"]);
});
