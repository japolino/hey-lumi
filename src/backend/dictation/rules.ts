/** Small code rules applied after Jev labels the units (spec/dictation-bench.md, method J step 4). */
import type { DictationLabel } from "../../shared/protocol";
import { tokens, type Unit } from "./segment";

const THINK_TAG = /^(?:and |but )?(?:i|he|she|they|we|[a-z]+)(?:'m|'s| am| is)?\s+(?:think|thinks|thinking|wonder|wonders|wondering|thought|wondered)[.,!?]?$/i;
const SAY_TAG =
  /^(?:and |but |then )?(?:i|he|she|they|we|[a-z]+)\s+(?:\w+ly\s+)?(?:say|says|said|ask|asks|whisper|whispers|shout|shouts|yell|yells|mutter|mutters|snarl|snarls|warn|warns|reply|replies)(?:\s+\w+ly)?[.,!?]?$/i;

const isTag = (t: string) => THINK_TAG.test(t.trim()) || SAY_TAG.test(t.trim());

/**
 * A bare tag unit ("I think.", "she says") is narration; dialogue in the same sentence just before a think tag is thought.
 * Then a short unit (3 words or fewer, not a tag) between two same-label units inside one sentence takes that label.
 */
export function applyRules(units: Unit[], input: DictationLabel[]): DictationLabel[] {
  const labels = [...input];
  units.forEach((u, i) => {
    if (THINK_TAG.test(u.text.trim())) {
      labels[i] = "narration";
      for (let j = i - 1; j >= 0 && labels[j] === "dialogue" && !(j + 1 < i && units[j + 1]!.sentStart); j--) labels[j] = "thought";
    } else if (SAY_TAG.test(u.text.trim())) {
      labels[i] = "narration";
    }
  });
  for (let i = 1; i < units.length - 1; i++) {
    const u = units[i]!;
    if (
      labels[i - 1] === labels[i + 1] &&
      labels[i] !== labels[i - 1] &&
      !u.sentStart &&
      !units[i + 1]!.sentStart &&
      tokens(u.text).length <= 3 &&
      !isTag(u.text)
    ) {
      labels[i] = labels[i - 1]!;
    }
  }
  return labels;
}
