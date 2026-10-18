import type { ActionCandidate, EntityOption } from "../../shared/protocol";
import type { Services } from "../services/types";
import { normalize, rankLexical } from "./fuzzy";

export const CANDIDATE_LIMIT = 40;
export const ENTITY_LIMIT = 40;

const candidateFields = (c: ActionCandidate) => [
  { text: c.label, weight: 1 },
  { text: (c.keywords ?? []).join(" "), weight: 0.8 },
  { text: c.description ?? "", weight: 0.5 },
];

const passageText = (c: ActionCandidate) => [c.label, c.description, (c.keywords ?? []).join(", ")].filter(Boolean).join(". ");

/** Passage vectors by cacheKey + text. Vectors from different cache keys are never mixed. */
const vectorCache = new Map<string, number[]>();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

async function rankByEmbedding(utterance: string, items: ActionCandidate[], embed: NonNullable<Services["embed"]>): Promise<ActionCandidate[]> {
  const query = await embed([utterance], "query");
  const key = (c: ActionCandidate) => `${query.cacheKey}\n${passageText(c)}`;
  const missing = [...new Set(items.filter((c) => !vectorCache.has(key(c))).map(passageText))];
  if (missing.length) {
    const passages = await embed(missing, "passage");
    missing.forEach((text, i) => vectorCache.set(`${passages.cacheKey}\n${text}`, passages.vectors[i]!));
  }
  const q = query.vectors[0]!;
  return items
    .map((c) => ({ c, score: vectorCache.has(key(c)) ? cosine(q, vectorCache.get(key(c))!) : -1 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

/** Drops candidates whose label and description repeat an earlier one (e.g. a drawer tab and its palette command). */
export function dedupeCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = normalize(`${c.label} ${c.description ?? ""}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Keeps every Lumi action and the host surfaces that match the utterance best (lexical and, when available,
 * embedding ranks taken in turns), up to `limit`. Best matches come first; unmatched surfaces fill the rest.
 */
export async function narrowCandidates(
  utterance: string,
  candidates: ActionCandidate[],
  services: Services,
  limit = CANDIDATE_LIMIT,
): Promise<ActionCandidate[]> {
  const unique = dedupeCandidates(candidates);
  const isPinned = (c: ActionCandidate) => c.id.startsWith("lumi:");
  const ranks = [rankLexical(utterance, unique, candidateFields).filter((x) => x.score > 0).map((x) => x.item)];
  if (services.embed) {
    try {
      ranks.push(await rankByEmbedding(utterance, unique, services.embed));
    } catch (err) {
      services.log("warn", `embedding narrowing failed: ${err}`);
    }
  }
  const budget = limit - unique.filter(isPinned).length;
  const picked = new Set<ActionCandidate>();
  let surfaces = 0;
  const add = (c: ActionCandidate | undefined) => {
    if (!c || picked.has(c) || (!isPinned(c) && surfaces >= budget)) return;
    picked.add(c);
    if (!isPinned(c)) surfaces++;
  };
  const longest = Math.max(...ranks.map((r) => r.length));
  for (let i = 0; i < longest; i++) for (const r of ranks) add(r[i]);
  unique.forEach(add);
  return [...picked];
}

/** Entities of one kind ranked by name (and detail) match, best first, at most `limit`. */
export function narrowEntities(utterance: string, entities: EntityOption[], limit = ENTITY_LIMIT): Array<{ item: EntityOption; score: number }> {
  return rankLexical(utterance, entities, (e) => [
    { text: e.name, weight: 1 },
    { text: e.detail ?? "", weight: 0.4 },
  ]).slice(0, limit);
}
