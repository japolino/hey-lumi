/** Jev requests for dictation: unit labels + paragraph and speaker nouls, and word-gap nouls for unpunctuated text. */
import type { DecisionAnswers, DecisionQuestion } from "lumiverse-spindle-types";
import type { DictationLabel } from "../../shared/protocol";
import type { Services } from "../services/types";
import type { Unit } from "./segment";

type Questions = Record<string, DecisionQuestion>;

const GUIDE =
  "This is a roleplay message the player dictated by voice (speech-to-text). The player writes their character's actions, " +
  "spoken lines and inner thoughts, and may also talk out of character (OOC) to their roleplay partner. " +
  "The transcript has no quote marks; your answers decide the formatting.";

/** Narration first: Jev leans to the first option. */
const LABEL_CRITERIA = {
  narration:
    "Story narration: actions, description, events, and speech or thought tags such as 'I say', 'she whispers', 'I think to myself'. Reported speech ('I tell her that I'm fine') is narration.",
  dialogue: "The exact words a character says out loud in the story (would go inside quote marks).",
  thought: "The exact words of a character's unspoken inner thought (would go in italics), not the tag 'I think'.",
  ooc: "Out of character: the player talking to the roleplay partner about the roleplay itself (requests, questions about the story or rules, breaks, apologies), not story content. Often starts with 'OOC' or 'out of character'.",
} satisfies Record<DictationLabel, string>;

const SEG_GUIDE =
  "A roleplay message the player dictated by voice. Speech-to-text gave it without punctuation or capitals. " +
  "It mixes story narration (actions, description, tags like 'i say'), spoken dialogue, inner thoughts, and out-of-character (OOC) talk to the roleplay partner.";

const numbered = (units: Unit[]) => units.map((u, i) => `[${i + 1}] ${u.text}`).join("\n");

/**
 * Questions for one chunk of units. `prev` is the unit before the chunk (paragraph and speaker questions for the
 * chunk's first unit). Paragraph and speaker nouls are asked at every sentence start; code uses a speaker noul only
 * when both units end up as dialogue.
 */
export function labelRequest(units: Unit[], prev?: Unit): { state: Record<string, string>; questions: Questions } {
  const questions: Questions = {};
  units.forEach((u, i) => {
    questions[`u${i + 1}`] = {
      type: "choice",
      instructions: {
        question: `In \`transcript\`, what kind of text is unit [${i + 1}]?`,
        unit: u.text,
        before: i > 0 ? units[i - 1]!.text : (prev?.text ?? ""),
        after: i + 1 < units.length ? units[i + 1]!.text : "",
      },
      criteria: LABEL_CRITERIA,
    };
  });
  units.forEach((u, i) => {
    const before = i > 0 ? units[i - 1] : prev;
    if (!before || !u.sentStart) return;
    questions[`p${i + 1}`] = {
      type: "noul",
      instructions: {
        question: `When this dictation is written up as a roleplay reply, should a new paragraph start at unit [${i + 1}] of \`transcript\`? Say yes for a scene change, a time skip, or a clear shift to a new beat; say no when it continues the same moment.`,
        previous: before.text,
        unit: u.text,
      },
    };
    questions[`s${i + 1}`] = {
      type: "noul",
      instructions: {
        question: `If the unit before [${i + 1}] and unit [${i + 1}] of \`transcript\` are both spoken lines, is unit [${i + 1}] said by a different character than the line before it?`,
        line_before: before.text,
        line: u.text,
      },
    };
  });
  return { state: { guide: GUIDE, transcript: numbered(units) }, questions };
}

export interface ChunkLabels {
  labels: DictationLabel[];
  confidence: number[];
  /** Local unit index -> noul. */
  paragraph: Map<number, number>;
  speaker: Map<number, number>;
}

export function readLabels(n: number, answers: DecisionAnswers<Questions>): ChunkLabels {
  const out: ChunkLabels = { labels: [], confidence: [], paragraph: new Map(), speaker: new Map() };
  for (let i = 0; i < n; i++) {
    const a = answers[`u${i + 1}`];
    const choice = a && "choice" in a ? a.choice : "narration";
    out.labels.push(choice in LABEL_CRITERIA ? (choice as DictationLabel) : "narration");
    out.confidence.push(a && "confidence" in a ? a.confidence : 0);
  }
  for (const [k, a] of Object.entries(answers)) {
    if (!("noul" in a)) continue;
    const i = Number(k.slice(1)) - 1;
    if (k[0] === "p") out.paragraph.set(i, a.noul);
    else if (k[0] === "s") out.speaker.set(i, a.noul);
  }
  return out;
}

export async function jevLabels(units: Unit[], prev: Unit | undefined, services: Services, signal?: AbortSignal): Promise<ChunkLabels> {
  const answers = await services.decide(labelRequest(units, prev), { signal });
  return readLabels(units.length, answers);
}

const GAP_LEFT = 8;
const GAP_RIGHT = 6;

/** Noul per word gap k in [from, to) (gap k = before word k): does a sentence start there? */
export function gapRequest(words: string[], from: number, to: number): { state: Record<string, string>; questions: Questions } {
  const questions: Questions = {};
  for (let i = Math.max(1, from); i < to; i++) {
    questions[`g${i}`] = {
      type: "noul",
      instructions: {
        question:
          "The bar | marks a gap between two words of `dictation`. Does a new sentence start right after the bar (a period, question mark or exclamation mark belongs before it)?",
        text: `${words.slice(Math.max(0, i - GAP_LEFT), i).join(" ")} | ${words.slice(i, i + GAP_RIGHT).join(" ")}`,
      },
    };
  }
  const dictation = words.slice(Math.max(0, from - GAP_LEFT), to + GAP_RIGHT).join(" ");
  return { state: { guide: SEG_GUIDE, dictation }, questions };
}

export async function jevGaps(words: string[], from: number, to: number, services: Services, signal?: AbortSignal): Promise<Map<number, number>> {
  const answers = await services.decide(gapRequest(words, from, to), { signal });
  const out = new Map<number, number>();
  for (const [k, a] of Object.entries(answers)) if ("noul" in a) out.set(Number(k.slice(1)), a.noul);
  return out;
}
