/** Text helpers and code segmentation for dictation (spec/dictation-bench.md, approach J). */

export interface Unit {
  text: string;
  /** First unit of a sentence. */
  sentStart: boolean;
}

/** Lowercase word list used to check that words did not change. */
export function tokens(s: string): string[] {
  return s.replace(/[\u2018\u2019]/g, "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

export function sameWords(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}

export function sentenceMarks(s: string): number {
  return s.match(/[.?!]/g)?.length ?? 0;
}

/** At least one sentence mark per 25 words. */
export function isPunctuated(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean).length;
  return sentenceMarks(s) >= Math.max(1, Math.floor(words / 25));
}

const isCaps = (w: string) => /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w);
const MIN_CAPS_RUN = 3;

/** Remove stray quote marks and asterisks; lowercase runs of 3+ ALL-CAPS words (keeping I and OOC). */
export function cleanTranscript(raw: string): string {
  const words = raw.replace(/["\u201c\u201d*]/g, " ").split(/\s+/).filter(Boolean);
  const out = [...words];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && isCaps(words[j]!)) j++;
    if (j - i >= MIN_CAPS_RUN) {
      for (let k = i; k < j; k++) {
        const w = words[k]!;
        if (/^\W*OOC\W*$/.test(w)) continue;
        let low = w.toLowerCase().replace(/\bi\b/g, "I");
        if (k === 0 || /[.?!]$/.test(out[k - 1]!)) low = low.replace(/\p{L}/u, (c) => c.toUpperCase());
        out[k] = low;
      }
    }
    i = Math.max(j, i + 1);
  }
  return out.join(" ");
}

/** Speech or thought tag with a subject ("I say", "she whispers", "I think to myself"); a unit ends after it. */
const TAG_RE =
  /\b(?:I|he|she|they|we|[A-Z][a-z]+)\s+(?:says?|said|asks?|whispers?|shouts?|yells?|mutters?|snarls?|warns?|thinks? to (?:myself|himself|herself)|tell(?:s|ing)? (?:myself|himself|herself)|asks? (?:myself|himself|herself))\b(?=\s+[A-Za-z])/gi;

function splitTags(s: string, firstIsStart: boolean, out: Unit[]): void {
  let pos = 0;
  const parts: string[] = [];
  for (const m of s.matchAll(TAG_RE)) {
    parts.push(s.slice(pos, m.index + m[0].length));
    pos = m.index + m[0].length;
  }
  parts.push(s.slice(pos));
  let first = firstIsStart;
  for (const p of parts) {
    const t = p.trim();
    if (t) {
      out.push({ text: t, sentStart: first });
      first = false;
    }
  }
}

/** Split punctuated text into units: sentence ends, commas, and after speech or thought tags. */
export function segUnits(text: string): Unit[] {
  const units: Unit[] = [];
  for (const sent of text.trim().split(/(?<=[.?!])\s+/)) {
    if (!sent) continue;
    let first = true;
    for (const part of sent.split(/(?<=,)\s+/)) {
      const before = units.length;
      splitTags(part, first, units);
      if (units.length > before) first = false;
    }
  }
  return units;
}

const FILLERS = new Set([
  "uh", "um", "uhh", "umm", "er", "erm", "hmm", "so", "oh", "wait", "hey", "okay", "ok", "well", "like",
  "anyway", "alright", "right", "you", "know", "and", "but",
]);

/** A unit made only of filler words ("Uh,", "Oh wait,") joins the next unit of the same sentence. */
export function mergeFillers(units: Unit[]): Unit[] {
  const out: Unit[] = [];
  let carry: Unit | null = null;
  units.forEach((unit, i) => {
    let u = unit;
    const tw = tokens(u.text);
    const isFiller = tw.length > 0 && tw.every((w) => FILLERS.has(w));
    const nextSameSentence = i + 1 < units.length && !units[i + 1]!.sentStart;
    if (carry) {
      u = { text: `${carry.text} ${u.text}`, sentStart: carry.sentStart };
      carry = null;
    }
    if (isFiller && nextSameSentence && tokens(u.text).length <= 3) {
      carry = u;
      return;
    }
    out.push(u);
  });
  if (carry) out.push(carry);
  return out;
}

/** Words a sentence rarely ends on: a cut after one moves one word back. */
const NO_END = new Set([
  "i", "the", "a", "an", "my", "his", "her", "their", "our", "your", "she", "he", "we", "they", "and", "to",
  "of", "in", "on", "at", "with", "as", "so",
]);

/** Sentence cuts (word indexes) from gap nouls (gap k = before word k) above `thr`. */
export function shiftGaps(words: string[], gaps: Map<number, number>, thr: number): Set<number> {
  const cuts = new Set<number>();
  for (const [k, v] of gaps) {
    if (v <= thr) continue;
    let kk = k;
    while (kk > 1 && NO_END.has(words[kk - 1]!.toLowerCase())) kk--;
    cuts.add(kk);
  }
  return cuts;
}

/** Units for unpunctuated text: sentences from the cuts, then tag splits. */
export function unitsFromCuts(words: string[], cuts: Set<number>): Unit[] {
  const sentences: string[] = [];
  let cur: string[] = [];
  words.forEach((w, i) => {
    if (i > 0 && cuts.has(i)) {
      sentences.push(cur.join(" "));
      cur = [];
    }
    cur.push(w);
  });
  sentences.push(cur.join(" "));
  const out: Unit[] = [];
  for (const s of sentences) splitTags(s, true, out);
  return out;
}
