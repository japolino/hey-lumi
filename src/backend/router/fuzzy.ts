/** Lexical fuzzy matching that survives speech-to-text slips ("claw" for Claude, "lore book" for Lorebook). */

const STOPWORDS = new Set(
  "a an the my me i to of for in on at it is be and or with please can could would you your hey lumi go want wanna need that this some up".split(" "),
);

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words of `text`, plus each pair of neighbours joined ("lore book" -> "lorebook"). */
export function terms(text: string, dropStopwords = false): string[] {
  const words = normalize(text).split(" ").filter((w) => w && !(dropStopwords && STOPWORDS.has(w)));
  const joined = words.slice(1).map((w, i) => words[i] + w);
  return [...words, ...joined];
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Rough sound key: similar consonants merged, vowels after the first letter dropped. */
function soundKey(word: string): string {
  const w = word.replace(/ph/g, "f").replace(/ck/g, "k").replace(/[cq]/g, "k").replace(/z/g, "s").replace(/x/g, "ks").replace(/v/g, "f");
  return (w[0] ?? "") + w.slice(1).replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1");
}

/** Similarity of two normalized words, 0..1. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3) return 0;
  let best = 0;
  if (long.startsWith(short)) best = 0.6 + 0.3 * (short.length / long.length);
  const ratio = 1 - editDistance(a, b) / long.length;
  if (ratio >= 0.6) best = Math.max(best, ratio);
  if (short.length >= 4 && soundKey(a) === soundKey(b)) best = Math.max(best, 0.8);
  let common = 0;
  while (common < short.length && short[common] === long[common]) common++;
  if (common >= 3 && common / short.length >= 0.6) best = Math.max(best, 0.4 + 0.1 * common);
  return Math.min(best, 0.95);
}

export interface Field {
  text: string;
  weight: number;
}

/**
 * Ranks items by how well the query's words match their fields. Rare field words count more (idf).
 * Returns every item with its score, best first; items with no match score 0.
 */
export function rankLexical<T>(query: string, items: readonly T[], fields: (item: T) => Field[]): Array<{ item: T; score: number }> {
  const queryTerms = [...new Set(terms(query, true))];
  const itemTerms = items.map((item) => fields(item).map((f) => ({ words: [...new Set(terms(f.text, true))], weight: f.weight })));
  const df = new Map<string, number>();
  for (const fs of itemTerms) for (const w of new Set(fs.flatMap((f) => f.words))) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + items.length / (df.get(w) ?? 1));
  const scored = items.map((item, i) => {
    let score = 0;
    for (const q of queryTerms) {
      let best = 0;
      for (const f of itemTerms[i]!) {
        for (const w of f.words) {
          const sim = wordSimilarity(q, w);
          if (sim >= 0.5) best = Math.max(best, sim * f.weight * idf(w));
        }
      }
      score += best;
    }
    return { item, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

/** Best word similarity between any query term and any word of `name` (how clearly a name was said). */
export function nameStrength(query: string, name: string): number {
  const queryTerms = terms(query, true);
  let best = 0;
  for (const w of terms(name)) for (const q of queryTerms) best = Math.max(best, wordSimilarity(q, w));
  return best;
}
