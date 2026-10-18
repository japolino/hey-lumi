/**
 * Dictation: code splits the transcript, one Jev request labels units and paragraph breaks, code formats
 * (spec/dictation-bench.md approach J). The user's words never change: code only adds marks and breaks.
 */
import type { DictateRequest, DictateResult, DictationLabel, RewriteRequest } from "../../shared/protocol";
import type { ChatMessage, Services } from "../services/types";
import { paragraphStarts, render, speakerStarts } from "./format";
import { jevGaps, jevLabels } from "./jev";
import { applyRules } from "./rules";
import { cleanTranscript, isPunctuated, mergeFillers, sameWords, segUnits, sentenceMarks, shiftGaps, tokens, unitsFromCuts, type Unit } from "./segment";

/** Words per label request: keeps one Jev request well under its 64k-token limit (about 1,000 words without speaker questions). */
const LABEL_CHUNK_WORDS = 500;
/** Words per gap request (one question per word). */
const GAP_CHUNK_WORDS = 200;
const GAP_THRESHOLD = 0.2;

const PUNCT_PROMPT =
  "You restore punctuation for speech-to-text output. Add sentence punctuation (. , ? !) and capital letters to the text below. " +
  "Do not add, remove, reorder or change any word. Do not add quote marks, asterisks, brackets or line breaks. Output only the text.\n\nText:\n";

const stripMarks = (s: string) => s.replace(/["\u201c\u201d*()[\]_]/g, "");

/** Split units into runs of whole sentences of at most `max` words (a longer sentence is its own chunk). */
export function chunkUnits(units: Unit[], max: number): Unit[][] {
  const chunks: Unit[][] = [];
  let cur: Unit[] = [];
  let words = 0;
  let sentence: Unit[] = [];
  const flushSentence = () => {
    const n = sentence.reduce((s, u) => s + tokens(u.text).length, 0);
    if (cur.length && words + n > max) {
      chunks.push(cur);
      cur = [];
      words = 0;
    }
    cur.push(...sentence);
    words += n;
    sentence = [];
  };
  for (const u of units) {
    if (u.sentStart && sentence.length) flushSentence();
    sentence.push(u);
  }
  if (sentence.length) flushSentence();
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function label(units: Unit[], services: Services) {
  const chunks = chunkUnits(units, LABEL_CHUNK_WORDS);
  let offset = 0;
  const jobs = chunks.map((c) => {
    const start = offset;
    offset += c.length;
    return jevLabels(c, units[start - 1], services).then((r) => ({ r, start }));
  });
  const labels: DictationLabel[] = [];
  const paragraph = new Map<number, number>();
  const speaker = new Map<number, number>();
  for (const { r, start } of await Promise.all(jobs)) {
    labels.push(...r.labels);
    for (const [i, v] of r.paragraph) paragraph.set(start + i, v);
    for (const [i, v] of r.speaker) speaker.set(start + i, v);
  }
  return { labels, paragraph, speaker };
}

async function sentenceCutsFromGaps(words: string[], services: Services): Promise<Set<number>> {
  const jobs: Promise<Map<number, number>>[] = [];
  for (let from = 0; from < words.length; from += GAP_CHUNK_WORDS) {
    jobs.push(jevGaps(words, from, Math.min(words.length, from + GAP_CHUNK_WORDS), services));
  }
  const gaps = new Map<number, number>();
  for (const m of await Promise.all(jobs)) for (const [k, v] of m) gaps.set(k, v);
  return shiftGaps(words, gaps, GAP_THRESHOLD);
}

/** LLM punctuation-only pass; null when it changed the words or added too little punctuation. */
async function llmPunctuate(text: string, services: Services): Promise<string | null> {
  try {
    const raw = await services.complete([{ role: "user", content: PUNCT_PROMPT + text }], { temperature: 0 });
    const p = stripMarks(raw).replace(/\s+/g, " ").trim();
    const words = text.split(/\s+/).length;
    if (sameWords(p, text) && sentenceMarks(p) >= Math.max(1, Math.floor(words / 25))) return p;
    services.log("warn", "dictation: punctuation pass changed the words or added none; using Jev gaps");
  } catch (err) {
    services.log("warn", `dictation: punctuation pass failed (${err instanceof Error ? err.message : String(err)}); using Jev gaps`);
  }
  return null;
}

export async function formatDictation(req: DictateRequest, services: Services): Promise<DictateResult> {
  const text = cleanTranscript(req.text);
  if (!text) return { text: "", units: [], punctuation: "stt" };

  let punctuation: DictateResult["punctuation"] = "stt";
  let units: Unit[];
  if (isPunctuated(text)) {
    units = mergeFillers(segUnits(text));
  } else {
    const punctuated = await llmPunctuate(text, services);
    if (punctuated) {
      punctuation = "llm";
      units = mergeFillers(segUnits(punctuated));
    } else {
      punctuation = "jev_gaps";
      const words = text.split(" ");
      units = mergeFillers(unitsFromCuts(words, await sentenceCutsFromGaps(words, services)));
    }
  }

  const r = await label(units, services);
  const labels = applyRules(units, r.labels);
  const paras = paragraphStarts(labels, r.paragraph);
  return {
    text: render(units, labels, paras, speakerStarts(labels, r.speaker), req.format),
    units: units.map((u, i) => ({ text: u.text, label: labels[i]!, paragraphStart: i === 0 || paras.has(i) })),
    punctuation,
  };
}

const MARKS =
  "Keep the same marks: dialogue in quotes, inner thoughts in *asterisks*, out-of-character notes in ((double parentheses)) " +
  "or [brackets] as in the draft.";

const REWRITE_SYSTEM: Record<RewriteRequest["mode"], string> = {
  polish:
    "You edit roleplay messages. Rewrite the player's draft as a better roleplay message: clearer, more vivid, well paced, " +
    `with the same events, meaning and intent. Keep the same person and tense. ${MARKS} ` +
    "Do not add events or speak for other characters. Use the recent messages only as context. Output only the rewritten message.",
  dictation:
    "You write roleplay messages from the player's voice dictation. Speech recognition may have misheard words: fix them " +
    "using the recent messages (names, places, things already in the story). Then turn the dictation into a full roleplay " +
    "message that fits the conversation: you may expand it with actions, description, feelings and dialogue for the " +
    "player's character, following what the player said and meant. Match the person and tense of the player's earlier " +
    `messages. ${MARKS} Do not decide what other characters do or say. Output only the message.`,
};

/** LLM rewrite of the draft with the last few chat messages as context. */
export async function rewriteDraft(
  draft: string,
  recent: ChatMessage[],
  services: Services,
  options: { mode?: RewriteRequest["mode"]; before?: string } = {},
): Promise<string> {
  const mode = options.mode ?? "polish";
  const context = recent
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "Player" : "Partner"}: ${m.content}`)
    .join("\n\n");
  const before = options.before?.trim() ? `Already written in this message (keep, do not repeat):\n${options.before.trim()}\n\n` : "";
  const label = mode === "dictation" ? "Dictation" : "Draft to rewrite";
  const user = `${context ? `Recent messages:\n${context}\n\n` : ""}${before}${label}:\n${draft}`;
  const out = await services.complete([
    { role: "system", content: REWRITE_SYSTEM[mode] },
    { role: "user", content: user },
  ]);
  return out.trim();
}
