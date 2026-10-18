/** Code formatting of labelled units (spec/dictation-bench.md, method J step 3). */
import type { DictationFormat, DictationLabel } from "../../shared/protocol";
import type { Unit } from "./segment";

export const PARAGRAPH_THRESHOLD = 0.35;
export const SPEAKER_THRESHOLD = 0.5;

/** Unit indexes that start a paragraph: every OOC edge, else a paragraph noul above the threshold. */
export function paragraphStarts(labels: DictationLabel[], paraNoul: Map<number, number>): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < labels.length; i++) {
    const ooc = labels[i] === "ooc";
    if (ooc !== (labels[i - 1] === "ooc")) out.add(i);
    else if (!ooc && (paraNoul.get(i) ?? 0) > PARAGRAPH_THRESHOLD) out.add(i);
  }
  return out;
}

/** Dialogue units that start a new speaker's line (close and reopen the quotes). */
export function speakerStarts(labels: DictationLabel[], speakerNoul: Map<number, number>): Set<number> {
  const out = new Set<number>();
  for (const [i, v] of speakerNoul) {
    if (v > SPEAKER_THRESHOLD && labels[i] === "dialogue" && labels[i - 1] === "dialogue") out.add(i);
  }
  return out;
}

function wrap(text: string, label: DictationLabel, f: DictationFormat): string {
  switch (label) {
    case "dialogue":
      return f.quotes === "curly" ? `\u201c${text}\u201d` : `"${text}"`;
    case "thought":
      if (f.thought === "plain") return text;
      return text.endsWith(",") ? `*${text.slice(0, -1)}*,` : `*${text}*`;
    case "ooc":
      return f.ooc === "brackets" ? `[${text}]` : `((${text}))`;
    default:
      return text;
  }
}

/** Join runs of same-label units, wrap each run, separate paragraphs with a blank line. */
export function render(
  units: Unit[],
  labels: DictationLabel[],
  paras: Set<number>,
  speakers: Set<number>,
  f: DictationFormat,
): string {
  const paragraphs: string[][] = [];
  let line: string[] = [];
  let run: string[] = [];
  let runLabel: DictationLabel | null = null;
  const closeRun = () => {
    if (runLabel) line.push(wrap(run.join(" "), runLabel, f));
    run = [];
    runLabel = null;
  };
  units.forEach((u, i) => {
    const label = labels[i]!;
    if (i > 0 && paras.has(i)) {
      closeRun();
      paragraphs.push(line);
      line = [];
    } else if (label !== runLabel || speakers.has(i)) {
      closeRun();
    }
    runLabel = label;
    run.push(u.text);
  });
  closeRun();
  paragraphs.push(line);
  return paragraphs
    .map((p) => p.join(" "))
    .filter(Boolean)
    .join("\n\n");
}
