// src/backend/entities.ts
var TTL_MS = 60000;
var MAX_CHARACTERS = 2000;
function createEntityLists(host) {
  const cache = new Map;
  async function load(kind, userId) {
    if (kind === "character") {
      const items = [];
      for (let offset = 0;offset < MAX_CHARACTERS; offset += 200) {
        const page = await host.characters.list({ limit: 200, offset, ...userId ? { userId } : {} });
        for (const c of page.data) {
          items.push({ id: c.id, name: c.name, detail: c.tags.slice(0, 6).join(", ") || undefined, imageId: c.image_id ?? undefined });
        }
        if (page.data.length < 200 || items.length >= page.total)
          break;
      }
      return items;
    }
    if (kind === "persona") {
      const page = await host.personas.list({ limit: 500, ...userId ? { userId } : {} });
      return page.data.map((p) => ({ id: p.id, name: p.name, detail: p.title || undefined, imageId: p.image_id ?? undefined }));
    }
    const page = await host.presets.list({ limit: 500, ...userId ? { userId } : {} });
    return page.data.map((p) => ({ id: p.id, name: p.name }));
  }
  const permission = { character: "characters", persona: "personas", preset: "presets" };
  return {
    async get(kind, userId) {
      if (!host.permissions.has(permission[kind]))
        return;
      const key = `${userId ?? ""}:${kind}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS)
        return hit.items;
      const items = await load(kind, userId);
      cache.set(key, { at: Date.now(), items });
      return items;
    },
    clear() {
      cache.clear();
    }
  };
}

// src/backend/dictation/format.ts
var PARAGRAPH_THRESHOLD = 0.35;
var SPEAKER_THRESHOLD = 0.5;
function paragraphStarts(labels, paraNoul) {
  const out = new Set;
  for (let i = 1;i < labels.length; i++) {
    const ooc = labels[i] === "ooc";
    if (ooc !== (labels[i - 1] === "ooc"))
      out.add(i);
    else if (!ooc && (paraNoul.get(i) ?? 0) > PARAGRAPH_THRESHOLD)
      out.add(i);
  }
  return out;
}
function speakerStarts(labels, speakerNoul) {
  const out = new Set;
  for (const [i, v] of speakerNoul) {
    if (v > SPEAKER_THRESHOLD && labels[i] === "dialogue" && labels[i - 1] === "dialogue")
      out.add(i);
  }
  return out;
}
function wrap(text, label, f) {
  switch (label) {
    case "dialogue":
      return f.quotes === "curly" ? `“${text}”` : `"${text}"`;
    case "thought":
      if (f.thought === "plain")
        return text;
      return text.endsWith(",") ? `*${text.slice(0, -1)}*,` : `*${text}*`;
    case "ooc":
      return f.ooc === "brackets" ? `[${text}]` : `((${text}))`;
    default:
      return text;
  }
}
function render(units, labels, paras, speakers, f) {
  const paragraphs = [];
  let line = [];
  let run = [];
  let runLabel = null;
  const closeRun = () => {
    if (runLabel)
      line.push(wrap(run.join(" "), runLabel, f));
    run = [];
    runLabel = null;
  };
  units.forEach((u, i) => {
    const label = labels[i];
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
  return paragraphs.map((p) => p.join(" ")).filter(Boolean).join(`

`);
}

// src/backend/dictation/jev.ts
var GUIDE = "This is a roleplay message the player dictated by voice (speech-to-text). The player writes their character's actions, " + "spoken lines and inner thoughts, and may also talk out of character (OOC) to their roleplay partner. " + "The transcript has no quote marks; your answers decide the formatting.";
var LABEL_CRITERIA = {
  narration: "Story narration: actions, description, events, and speech or thought tags such as 'I say', 'she whispers', 'I think to myself'. Reported speech ('I tell her that I'm fine') is narration.",
  dialogue: "The exact words a character says out loud in the story (would go inside quote marks).",
  thought: "The exact words of a character's unspoken inner thought (would go in italics), not the tag 'I think'.",
  ooc: "Out of character: the player talking to the roleplay partner about the roleplay itself (requests, questions about the story or rules, breaks, apologies), not story content. Often starts with 'OOC' or 'out of character'."
};
var SEG_GUIDE = "A roleplay message the player dictated by voice. Speech-to-text gave it without punctuation or capitals. " + "It mixes story narration (actions, description, tags like 'i say'), spoken dialogue, inner thoughts, and out-of-character (OOC) talk to the roleplay partner.";
var numbered = (units) => units.map((u, i) => `[${i + 1}] ${u.text}`).join(`
`);
function labelRequest(units, prev) {
  const questions = {};
  units.forEach((u, i) => {
    questions[`u${i + 1}`] = {
      type: "choice",
      instructions: {
        question: `In \`transcript\`, what kind of text is unit [${i + 1}]?`,
        unit: u.text,
        before: i > 0 ? units[i - 1].text : prev?.text ?? "",
        after: i + 1 < units.length ? units[i + 1].text : ""
      },
      criteria: LABEL_CRITERIA
    };
  });
  units.forEach((u, i) => {
    const before = i > 0 ? units[i - 1] : prev;
    if (!before || !u.sentStart)
      return;
    questions[`p${i + 1}`] = {
      type: "noul",
      instructions: {
        question: `When this dictation is written up as a roleplay reply, should a new paragraph start at unit [${i + 1}] of \`transcript\`? Say yes for a scene change, a time skip, or a clear shift to a new beat; say no when it continues the same moment.`,
        previous: before.text,
        unit: u.text
      }
    };
    questions[`s${i + 1}`] = {
      type: "noul",
      instructions: {
        question: `If the unit before [${i + 1}] and unit [${i + 1}] of \`transcript\` are both spoken lines, is unit [${i + 1}] said by a different character than the line before it?`,
        line_before: before.text,
        line: u.text
      }
    };
  });
  return { state: { guide: GUIDE, transcript: numbered(units) }, questions };
}
function readLabels(n, answers) {
  const out = { labels: [], confidence: [], paragraph: new Map, speaker: new Map };
  for (let i = 0;i < n; i++) {
    const a = answers[`u${i + 1}`];
    const choice = a && "choice" in a ? a.choice : "narration";
    out.labels.push(choice in LABEL_CRITERIA ? choice : "narration");
    out.confidence.push(a && "confidence" in a ? a.confidence : 0);
  }
  for (const [k, a] of Object.entries(answers)) {
    if (!("noul" in a))
      continue;
    const i = Number(k.slice(1)) - 1;
    if (k[0] === "p")
      out.paragraph.set(i, a.noul);
    else if (k[0] === "s")
      out.speaker.set(i, a.noul);
  }
  return out;
}
async function jevLabels(units, prev, services, signal) {
  const answers = await services.decide(labelRequest(units, prev), { signal });
  return readLabels(units.length, answers);
}
var GAP_LEFT = 8;
var GAP_RIGHT = 6;
function gapRequest(words, from, to) {
  const questions = {};
  for (let i = Math.max(1, from);i < to; i++) {
    questions[`g${i}`] = {
      type: "noul",
      instructions: {
        question: "The bar | marks a gap between two words of `dictation`. Does a new sentence start right after the bar (a period, question mark or exclamation mark belongs before it)?",
        text: `${words.slice(Math.max(0, i - GAP_LEFT), i).join(" ")} | ${words.slice(i, i + GAP_RIGHT).join(" ")}`
      }
    };
  }
  const dictation = words.slice(Math.max(0, from - GAP_LEFT), to + GAP_RIGHT).join(" ");
  return { state: { guide: SEG_GUIDE, dictation }, questions };
}
async function jevGaps(words, from, to, services, signal) {
  const answers = await services.decide(gapRequest(words, from, to), { signal });
  const out = new Map;
  for (const [k, a] of Object.entries(answers))
    if ("noul" in a)
      out.set(Number(k.slice(1)), a.noul);
  return out;
}

// src/backend/dictation/segment.ts
function tokens(s) {
  return s.replace(/[\u2018\u2019]/g, "'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}
function sameWords(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  return x.length === y.length && x.every((w, i) => w === y[i]);
}
function sentenceMarks(s) {
  return s.match(/[.?!]/g)?.length ?? 0;
}
function isPunctuated(s) {
  const words = s.split(/\s+/).filter(Boolean).length;
  return sentenceMarks(s) >= Math.max(1, Math.floor(words / 25));
}
var isCaps = (w) => /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w);
var MIN_CAPS_RUN = 3;
function cleanTranscript(raw) {
  const words = raw.replace(/["\u201c\u201d*]/g, " ").split(/\s+/).filter(Boolean);
  const out = [...words];
  for (let i = 0;i < words.length; ) {
    let j = i;
    while (j < words.length && isCaps(words[j]))
      j++;
    if (j - i >= MIN_CAPS_RUN) {
      for (let k = i;k < j; k++) {
        const w = words[k];
        if (/^\W*OOC\W*$/.test(w))
          continue;
        let low = w.toLowerCase().replace(/\bi\b/g, "I");
        if (k === 0 || /[.?!]$/.test(out[k - 1]))
          low = low.replace(/\p{L}/u, (c) => c.toUpperCase());
        out[k] = low;
      }
    }
    i = Math.max(j, i + 1);
  }
  return out.join(" ");
}
var TAG_RE = /\b(?:I|he|she|they|we|[A-Z][a-z]+)\s+(?:says?|said|asks?|whispers?|shouts?|yells?|mutters?|snarls?|warns?|thinks? to (?:myself|himself|herself)|tell(?:s|ing)? (?:myself|himself|herself)|asks? (?:myself|himself|herself))\b(?=\s+[A-Za-z])/gi;
function splitTags(s, firstIsStart, out) {
  let pos = 0;
  const parts = [];
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
function segUnits(text) {
  const units = [];
  for (const sent of text.trim().split(/(?<=[.?!])\s+/)) {
    if (!sent)
      continue;
    let first = true;
    for (const part of sent.split(/(?<=,)\s+/)) {
      const before = units.length;
      splitTags(part, first, units);
      if (units.length > before)
        first = false;
    }
  }
  return units;
}
var FILLERS = new Set([
  "uh",
  "um",
  "uhh",
  "umm",
  "er",
  "erm",
  "hmm",
  "so",
  "oh",
  "wait",
  "hey",
  "okay",
  "ok",
  "well",
  "like",
  "anyway",
  "alright",
  "right",
  "you",
  "know",
  "and",
  "but"
]);
function mergeFillers(units) {
  const out = [];
  let carry = null;
  units.forEach((unit, i) => {
    let u = unit;
    const tw = tokens(u.text);
    const isFiller = tw.length > 0 && tw.every((w) => FILLERS.has(w));
    const nextSameSentence = i + 1 < units.length && !units[i + 1].sentStart;
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
  if (carry)
    out.push(carry);
  return out;
}
var NO_END = new Set([
  "i",
  "the",
  "a",
  "an",
  "my",
  "his",
  "her",
  "their",
  "our",
  "your",
  "she",
  "he",
  "we",
  "they",
  "and",
  "to",
  "of",
  "in",
  "on",
  "at",
  "with",
  "as",
  "so"
]);
function shiftGaps(words, gaps, thr) {
  const cuts = new Set;
  for (const [k, v] of gaps) {
    if (v <= thr)
      continue;
    let kk = k;
    while (kk > 1 && NO_END.has(words[kk - 1].toLowerCase()))
      kk--;
    cuts.add(kk);
  }
  return cuts;
}
function unitsFromCuts(words, cuts) {
  const sentences = [];
  let cur = [];
  words.forEach((w, i) => {
    if (i > 0 && cuts.has(i)) {
      sentences.push(cur.join(" "));
      cur = [];
    }
    cur.push(w);
  });
  sentences.push(cur.join(" "));
  const out = [];
  for (const s of sentences)
    splitTags(s, true, out);
  return out;
}

// src/backend/dictation/rules.ts
var THINK_TAG = /^(?:and |but )?(?:i|he|she|they|we|[a-z]+)(?:'m|'s| am| is)?\s+(?:think|thinks|thinking|wonder|wonders|wondering|thought|wondered)[.,!?]?$/i;
var SAY_TAG = /^(?:and |but |then )?(?:i|he|she|they|we|[a-z]+)\s+(?:\w+ly\s+)?(?:say|says|said|ask|asks|whisper|whispers|shout|shouts|yell|yells|mutter|mutters|snarl|snarls|warn|warns|reply|replies)(?:\s+\w+ly)?[.,!?]?$/i;
var isTag = (t) => THINK_TAG.test(t.trim()) || SAY_TAG.test(t.trim());
function applyRules(units, input) {
  const labels = [...input];
  units.forEach((u, i) => {
    if (THINK_TAG.test(u.text.trim())) {
      labels[i] = "narration";
      for (let j = i - 1;j >= 0 && labels[j] === "dialogue" && !(j + 1 < i && units[j + 1].sentStart); j--)
        labels[j] = "thought";
    } else if (SAY_TAG.test(u.text.trim())) {
      labels[i] = "narration";
    }
  });
  for (let i = 1;i < units.length - 1; i++) {
    const u = units[i];
    if (labels[i - 1] === labels[i + 1] && labels[i] !== labels[i - 1] && !u.sentStart && !units[i + 1].sentStart && tokens(u.text).length <= 3 && !isTag(u.text)) {
      labels[i] = labels[i - 1];
    }
  }
  return labels;
}

// src/backend/dictation/index.ts
var LABEL_CHUNK_WORDS = 500;
var GAP_CHUNK_WORDS = 200;
var GAP_THRESHOLD = 0.2;
var PUNCT_PROMPT = "You restore punctuation for speech-to-text output. Add sentence punctuation (. , ? !) and capital letters to the text below. " + `Do not add, remove, reorder or change any word. Do not add quote marks, asterisks, brackets or line breaks. Output only the text.

Text:
`;
var stripMarks = (s) => s.replace(/["\u201c\u201d*()[\]_]/g, "");
function chunkUnits(units, max) {
  const chunks = [];
  let cur = [];
  let words = 0;
  let sentence = [];
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
    if (u.sentStart && sentence.length)
      flushSentence();
    sentence.push(u);
  }
  if (sentence.length)
    flushSentence();
  if (cur.length)
    chunks.push(cur);
  return chunks;
}
async function label(units, services) {
  const chunks = chunkUnits(units, LABEL_CHUNK_WORDS);
  let offset = 0;
  const jobs = chunks.map((c) => {
    const start = offset;
    offset += c.length;
    return jevLabels(c, units[start - 1], services).then((r) => ({ r, start }));
  });
  const labels = [];
  const paragraph = new Map;
  const speaker = new Map;
  for (const { r, start } of await Promise.all(jobs)) {
    labels.push(...r.labels);
    for (const [i, v] of r.paragraph)
      paragraph.set(start + i, v);
    for (const [i, v] of r.speaker)
      speaker.set(start + i, v);
  }
  return { labels, paragraph, speaker };
}
async function sentenceCutsFromGaps(words, services) {
  const jobs = [];
  for (let from = 0;from < words.length; from += GAP_CHUNK_WORDS) {
    jobs.push(jevGaps(words, from, Math.min(words.length, from + GAP_CHUNK_WORDS), services));
  }
  const gaps = new Map;
  for (const m of await Promise.all(jobs))
    for (const [k, v] of m)
      gaps.set(k, v);
  return shiftGaps(words, gaps, GAP_THRESHOLD);
}
async function llmPunctuate(text, services) {
  try {
    const raw = await services.complete([{ role: "user", content: PUNCT_PROMPT + text }], { temperature: 0 });
    const p = stripMarks(raw).replace(/\s+/g, " ").trim();
    const words = text.split(/\s+/).length;
    if (sameWords(p, text) && sentenceMarks(p) >= Math.max(1, Math.floor(words / 25)))
      return p;
    services.log("warn", "dictation: punctuation pass changed the words or added none; using Jev gaps");
  } catch (err) {
    services.log("warn", `dictation: punctuation pass failed (${err instanceof Error ? err.message : String(err)}); using Jev gaps`);
  }
  return null;
}
async function formatDictation(req, services) {
  const text = cleanTranscript(req.text);
  if (!text)
    return { text: "", units: [], punctuation: "stt" };
  let punctuation = "stt";
  let units;
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
    units: units.map((u, i) => ({ text: u.text, label: labels[i], paragraphStart: i === 0 || paras.has(i) })),
    punctuation
  };
}
var REWRITE_SYSTEM = "You edit roleplay messages. Rewrite the player's draft as a better roleplay message: clearer, more vivid, well paced, " + "with the same events, meaning and intent. Keep the same person and tense, and the same marks: dialogue in quotes, " + "inner thoughts in *asterisks*, out-of-character notes in ((double parentheses)) or [brackets] as in the draft. " + "Do not add events or speak for other characters. Use the recent messages only as context. Output only the rewritten message.";
async function rewriteDraft(draft, recent, services) {
  const context = recent.filter((m) => m.role !== "system").map((m) => `${m.role === "user" ? "Player" : "Partner"}: ${m.content}`).join(`

`);
  const user = `${context ? `Recent messages:
${context}

` : ""}Draft to rewrite:
${draft}`;
  const out = await services.complete([
    { role: "system", content: REWRITE_SYSTEM },
    { role: "user", content: user }
  ]);
  return out.trim();
}

// src/backend/router/dom.ts
var DOM_THRESHOLD = 0.4;
var NONE = "none";
async function pickControl(req, services) {
  if (!req.controls.length)
    return { controlId: null, confidence: 0 };
  const keys = new Map;
  const criteria = { [NONE]: "No visible control does what the user asked." };
  for (const c of req.controls) {
    const base = c.label.replace(/\s+/g, " ").trim().slice(0, 80) || c.role;
    let key = base;
    for (let n = 2;key.toLowerCase() === NONE || keys.has(key); n++)
      key = `${base} (${n})`;
    keys.set(key, c.id);
    criteria[key] = c.context ? `${c.role} in "${c.context}"` : c.role;
  }
  const { pick } = await services.decide({
    state: { utterance: req.utterance },
    questions: {
      pick: {
        type: "choice",
        instructions: "The user asked the voice assistant `utterance` (speech recognition may mishear words). Which visible control on the screen should be clicked to do it?",
        criteria
      }
    }
  });
  const controlId = pick.choice !== NONE && pick.confidence >= DOM_THRESHOLD ? keys.get(pick.choice) : null;
  return { controlId, confidence: pick.confidence };
}

// src/backend/router/fuzzy.ts
var STOPWORDS = new Set("a an the my me i to of for in on at it is be and or with please can could would you your hey lumi go want wanna need that this some up".split(" "));
function normalize(text) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function terms(text, dropStopwords = false) {
  const words = normalize(text).split(" ").filter((w) => w && !(dropStopwords && STOPWORDS.has(w)));
  const joined = words.slice(1).map((w, i) => words[i] + w);
  return [...words, ...joined];
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1;i <= a.length; i++) {
    const cur = [i];
    for (let j = 1;j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
function soundKey(word) {
  const w = word.replace(/ph/g, "f").replace(/ck/g, "k").replace(/[cq]/g, "k").replace(/z/g, "s").replace(/x/g, "ks").replace(/v/g, "f");
  return (w[0] ?? "") + w.slice(1).replace(/[aeiouyhw]/g, "").replace(/(.)\1+/g, "$1");
}
function wordSimilarity(a, b) {
  if (a === b)
    return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 3)
    return 0;
  let best = 0;
  if (long.startsWith(short))
    best = 0.6 + 0.3 * (short.length / long.length);
  const ratio = 1 - editDistance(a, b) / long.length;
  if (ratio >= 0.6)
    best = Math.max(best, ratio);
  if (short.length >= 4 && soundKey(a) === soundKey(b))
    best = Math.max(best, 0.8);
  let common = 0;
  while (common < short.length && short[common] === long[common])
    common++;
  if (common >= 3 && common / short.length >= 0.6)
    best = Math.max(best, 0.4 + 0.1 * common);
  return Math.min(best, 0.95);
}
function rankLexical(query, items, fields) {
  const queryTerms = [...new Set(terms(query, true))];
  const itemTerms = items.map((item) => fields(item).map((f) => ({ words: [...new Set(terms(f.text, true))], weight: f.weight })));
  const df = new Map;
  for (const fs of itemTerms)
    for (const w of new Set(fs.flatMap((f) => f.words)))
      df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w) => Math.log(1 + items.length / (df.get(w) ?? 1));
  const scored = items.map((item, i) => {
    let score = 0;
    for (const q of queryTerms) {
      let best = 0;
      for (const f of itemTerms[i]) {
        for (const w of f.words) {
          const sim = wordSimilarity(q, w);
          if (sim >= 0.5)
            best = Math.max(best, sim * f.weight * idf(w));
        }
      }
      score += best;
    }
    return { item, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}
function nameStrength(query, name) {
  const queryTerms = terms(query, true);
  let best = 0;
  for (const w of terms(name))
    for (const q of queryTerms)
      best = Math.max(best, wordSimilarity(q, w));
  return best;
}

// src/backend/router/narrow.ts
var CANDIDATE_LIMIT = 40;
var ENTITY_LIMIT = 40;
var candidateFields = (c) => [
  { text: c.label, weight: 1 },
  { text: (c.keywords ?? []).join(" "), weight: 0.8 },
  { text: c.description ?? "", weight: 0.5 }
];
var passageText = (c) => [c.label, c.description, (c.keywords ?? []).join(", ")].filter(Boolean).join(". ");
var vectorCache = new Map;
function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0;i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
async function rankByEmbedding(utterance, items, embed) {
  const query = await embed([utterance], "query");
  const key = (c) => `${query.cacheKey}
${passageText(c)}`;
  const missing = [...new Set(items.filter((c) => !vectorCache.has(key(c))).map(passageText))];
  if (missing.length) {
    const passages = await embed(missing, "passage");
    missing.forEach((text, i) => vectorCache.set(`${passages.cacheKey}
${text}`, passages.vectors[i]));
  }
  const q = query.vectors[0];
  return items.map((c) => ({ c, score: vectorCache.has(key(c)) ? cosine(q, vectorCache.get(key(c))) : -1 })).sort((a, b) => b.score - a.score).map((x) => x.c);
}
function dedupeCandidates(candidates) {
  const seen = new Set;
  return candidates.filter((c) => {
    const key = normalize(`${c.label} ${c.description ?? ""}`);
    if (seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
async function narrowCandidates(utterance, candidates, services, limit = CANDIDATE_LIMIT) {
  const unique = dedupeCandidates(candidates);
  const isPinned = (c) => c.id.startsWith("lumi:");
  const ranks = [rankLexical(utterance, unique, candidateFields).filter((x) => x.score > 0).map((x) => x.item)];
  if (services.embed) {
    try {
      ranks.push(await rankByEmbedding(utterance, unique, services.embed));
    } catch (err) {
      services.log("warn", `embedding narrowing failed: ${err}`);
    }
  }
  const budget = limit - unique.filter(isPinned).length;
  const picked = new Set;
  let surfaces = 0;
  const add = (c) => {
    if (!c || picked.has(c) || !isPinned(c) && surfaces >= budget)
      return;
    picked.add(c);
    if (!isPinned(c))
      surfaces++;
  };
  const longest = Math.max(...ranks.map((r) => r.length));
  for (let i = 0;i < longest; i++)
    for (const r of ranks)
      add(r[i]);
  unique.forEach(add);
  return [...picked];
}
function narrowEntities(utterance, entities, limit = ENTITY_LIMIT) {
  return rankLexical(utterance, entities, (e) => [
    { text: e.name, weight: 1 },
    { text: e.detail ?? "", weight: 0.4 }
  ]).slice(0, limit);
}

// src/backend/router/planner.ts
var MAX_STEPS = 6;
var MIN_NAME_MATCH = 0.7;
var SYSTEM = `You plan actions for Lumi, a voice assistant in the Lumiverse roleplay chat app.
Turn the user's spoken request (speech recognition may mishear words) into steps, using only the listed actions.
Reply with only a JSON array, e.g. [{"actionId":"lumi:persona_switch","args":{"persona":"Ava"}}].
"args" has one name for the argument kind an action needs (from the listed names), and is {} otherwise.
Reply [] if the listed actions cannot do the request.`;
function resolveEntity(value, entities) {
  const exact = entities.find((e) => e.id === value) ?? entities.find((e) => normalize(e.name) === normalize(value));
  if (exact)
    return exact.id;
  const best = narrowEntities(value, entities, 1)[0];
  return best && best.score > 0 && nameStrength(value, best.item.name) >= MIN_NAME_MATCH ? best.item.id : null;
}
function validatePlan(text, candidates, entities) {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS)
    return null;
  const steps = [];
  for (const item of raw) {
    const candidate = candidates.find((c) => c.id === item?.actionId);
    if (!candidate)
      return null;
    const step = { actionId: candidate.id, args: {} };
    if (candidate.arg) {
      const value = item.args?.[candidate.arg];
      const id = typeof value === "string" ? resolveEntity(value, entities[candidate.arg] ?? []) : null;
      if (!id)
        return null;
      step.args[candidate.arg] = id;
    }
    steps.push(step);
  }
  return steps;
}
async function planSteps(req, candidates, entities, services) {
  const actions = candidates.map((c) => `${c.id} | ${c.label}${c.description ? ` - ${c.description}` : ""}${c.arg ? ` | arg: ${c.arg}` : ""}`);
  const names = Object.entries(entities).filter(([, list]) => list?.length).map(([kind, list]) => `${kind}: ${list.map((e) => e.name).join(", ")}`);
  const { context } = req;
  const user = [
    "Actions:",
    ...actions,
    "",
    "Names:",
    ...names,
    "",
    `Screen: route ${context.route}, chat ${context.chatOpen ? "open" : "not open"}, draft ${context.draft ? "has text" : "empty"}.`,
    `Request: "${req.utterance}"`
  ].join(`
`);
  const text = await services.complete([
    { role: "system", content: SYSTEM },
    { role: "user", content: user }
  ], { temperature: 0, maxTokens: 400 });
  return validatePlan(text, candidates, entities);
}

// src/backend/router/questions.ts
var NO_ACTION = "none";
var UNCLEAR = "unclear";
var NO_PENDING = "none of these";
var IMAGE_LIMIT = 8;
var EXAMPLE_NAMES = 8;
var IMAGE_MIN = 280;
var IMAGE_MAX = 1568;
var LOOKS = /\b(hair|haired|eyes|eyed|wearing|wears|dress|glasses|blonde?|brunette|redhead|outfit|tattoo|skin|ears|horns?|tail|uniform|beard|bearded|mask|masked|hat|hood|hooded|helmet|scar|freckles|looks|looking|(one|girl|guy|woman|man|boy) (with|in|who|wearing))\b/i;
var ARG_NOUN = {
  character: "character",
  persona: "persona (the user's own identity in chats)",
  preset: "preset",
  theme: "theme",
  llm_profile: "LLM connection profile (an AI model setup, often named after the model or provider)",
  chat: "recent chat"
};
var LUMI_KEYWORDS = {
  "lumi:character_open": "open, show, profile, card, page",
  "lumi:character_chat_latest": "chat with, talk to, go back to, continue the chat with",
  "lumi:character_chat_new": "new chat, fresh chat, start a chat, start over with",
  "lumi:chat_open": "open chat, recent chat, go to the chat, that chat",
  "lumi:persona_switch": "persona, be, play as, I am, switch me to",
  "lumi:preset_switch": "preset, use preset, switch preset",
  "lumi:theme_apply": "theme, colors, look, dark, light, use theme",
  "lumi:llm_switch": "model, AI, connection, use, switch to, provider",
  "lumi:swipe_left": "swipe left, swipe back, previous reply, last swipe, go back one swipe",
  "lumi:swipe_right": "swipe right, next reply, another reply, new swipe",
  "lumi:stop": "stop, halt, cancel, enough, wait stop",
  "lumi:close": "close, close Lumi, go away, dismiss, that's all, goodbye",
  "lumi:stop_listening": "stop listening, mute, turn off the mic, stop the microphone, go to sleep",
  "lumi:draft_send": "send it, send, submit, post it, go ahead",
  "lumi:draft_rewrite": "rewrite, rephrase, improve, polish, make it better",
  "lumi:draft_clear": "clear, erase, delete the draft, scrap it, start over",
  "lumi:draft_read": "read it back, read aloud, what did I write",
  "lumi:undo": "undo, revert, put it back, change it back",
  "lumi:screen_control": "click, press, tap, button, toggle, the thing on screen"
};
var KIND_HINT = {
  drawer_tab: "opens a side panel",
  settings_tab: "opens a settings page",
  command: "runs a command",
  route: "goes to a page",
  modal: "opens a dialog"
};
function keyed(items, label, reserved) {
  const map = new Map;
  for (const item of items) {
    const base = label(item).replace(/\s+/g, " ").trim().slice(0, 80) || "option";
    let key = base;
    for (let n = 2;key.toLowerCase() === reserved || map.has(key); n++)
      key = `${base} (${n})`;
    map.set(key, item);
  }
  return map;
}
function actionCriterion(c, entities) {
  const kind = c.id.startsWith("surface:") ? c.id.split(":")[1] : "";
  const keywords = c.keywords?.length ? c.keywords.slice(0, 12).join(", ") : LUMI_KEYWORDS[c.id];
  const examples = c.arg ? (entities[c.arg] ?? []).slice(0, EXAMPLE_NAMES).map((r) => r.item.name) : [];
  return {
    does: c.description ?? c.label,
    ...KIND_HINT[kind] ? { kind: KIND_HINT[kind] } : {},
    ...keywords ? { keywords } : {},
    ...c.arg ? { needs: `a ${ARG_NOUN[c.arg]}${examples.length ? `, one of: ${examples.join(", ")}` : ""}` } : {}
  };
}
function wantsPortraits(utterance) {
  return LOOKS.test(utterance);
}
async function portraitRefs(ranked, services) {
  const refs = new Map;
  const withImage = ranked.filter((r) => r.item.imageId).slice(0, IMAGE_LIMIT);
  const sizes = await Promise.all(withImage.map((r) => services.portraitSize(r.item.imageId).catch(() => null)));
  withImage.forEach((r, i) => {
    const s = sizes[i];
    if (s && [s.width, s.height].every((px) => px >= IMAGE_MIN && px <= IMAGE_MAX))
      refs.set(r.item.id, `lumi-portrait-${i + 1}-${r.item.imageId}`);
  });
  return refs;
}
async function buildDecision(req, candidates, entities, services) {
  const { context } = req;
  const state = {
    utterance: req.utterance,
    app: {
      route: context.route,
      chat_open: context.chatOpen,
      generating_reply: context.generating,
      chat_draft: context.draft ? context.draft.slice(0, 300) : "(empty)"
    },
    session_so_far: context.history.slice(-4).map((h) => `user: ${h.said} -> Lumi: ${h.did}`),
    lumi_last_said: context.lumiSaid || "(nothing yet)"
  };
  const questions = {
    intent: {
      type: "choice",
      instructions: "The user is talking to Lumi, a voice assistant inside the Lumiverse roleplay chat app. `utterance` is what speech recognition heard (it may have errors). What is it? Use `app` and `session_so_far` for context.",
      criteria: {
        close: `The user is done with Lumi and ends the conversation: "that's about it", "I don't need anything else", "thanks Lumi, bye", "thanks, that's all", "okay, thank you", "great, thanks", "bye Lumi", "never mind, close". A thank-you right after Lumi finished a task (see \`lumi_last_said\`) is a close, even when speech recognition garbled the end ("thanks, Lumi, but...").`,
        command: "The user asks Lumi to do something in the app: open or go to something, switch or apply something, start a chat, regenerate, swipe, continue, stop, send, rewrite, clear or read the draft, change a setting.",
        dictation: `Text the user wants typed into the chat message: roleplay prose, a character's actions or dialogue, a reply in the story, or anything after "write" or "type".`,
        not_for_lumi: "Not meant for Lumi: the user talks to someone else in the room, background noise, or a meaningless fragment."
      }
    }
  };
  const actions = keyed(candidates, (c) => c.label, NO_ACTION);
  questions.action = {
    type: "choice",
    instructions: 'If `utterance` is a request to Lumi, which single action does the user want? Words may be misheard ("claw" can be Claude, "lore book" is Lorebook). Use `app` for context.',
    criteria: {
      [NO_ACTION]: "No listed action fits, the request is unclear, or it is not a request.",
      ...Object.fromEntries([...actions].map(([key, c]) => [key, actionCriterion(c, entities)]))
    }
  };
  const assets = {};
  const args = {};
  const neededKinds = [...new Set(candidates.flatMap((c) => c.arg ? [c.arg] : []))];
  for (const kind of neededKinds) {
    let ranked = entities[kind] ?? [];
    if (!ranked.length)
      continue;
    let portraits = new Map;
    if (kind === "character" && services.decisionImages && wantsPortraits(req.utterance)) {
      portraits = await portraitRefs(ranked, services);
      if (portraits.size)
        ranked = ranked.slice(0, IMAGE_LIMIT);
    }
    const options = keyed(ranked.map((r) => r.item), (e) => e.name, UNCLEAR);
    args[kind] = options;
    const criteria = {
      [UNCLEAR]: `The user names or describes no ${kind} from this list, or it is unclear which one. A name that sounds like one in the list counts as named.`
    };
    for (const [key, e] of options) {
      const ref = portraits.get(e.id);
      if (ref && e.imageId)
        assets[ref] = { image_id: e.imageId };
      criteria[key] = ref ? { name: e.name, ...e.detail ? { about: e.detail } : {}, portrait: ref } : e.detail ?? null;
    }
    questions[`arg_${kind}`] = {
      type: "choice",
      instructions: `Which ${ARG_NOUN[kind]} does \`utterance\` name or describe? Names may be misheard by speech recognition: pick the one that sounds closest.${portraits.size ? " Some options show the character's portrait; match descriptions of looks against it." : ""}`,
      criteria
    };
  }
  questions.multi = {
    type: "noul",
    instructions: 'Does `utterance` ask Lumi for two or more different app actions to be done one after another (for example "open themes and then switch my persona to Ava")? Describing one thing in several ways ("open the red haired one, Seo something") is one action.'
  };
  let pending;
  if (req.pending) {
    state.lumi_asked = req.pending.question;
    pending = keyed(req.pending.options, (o) => o.label, NO_PENDING);
    questions.pending = {
      type: "choice",
      instructions: 'Lumi just asked the user `lumi_asked`. Is `utterance` an answer that picks one of the options? "Yes", "the first one", "the second" or a (misheard) name count as picks.',
      criteria: {
        [NO_PENDING]: "The user picks none of the options, says no, or says something else.",
        ...Object.fromEntries([...pending.keys()].map((key, i) => [key, `option ${i + 1}`]))
      }
    };
  }
  return { input: { state, questions, ...Object.keys(assets).length ? { assets } : {} }, actions, args, pending };
}

// src/backend/router/route.ts
var THRESHOLDS = {
  intent: 0.5,
  close: 0.6,
  action: 0.5,
  actionAsk: 0.2,
  arg: 0.3,
  argShare: 0.8,
  argTied: 0.9,
  multi: 0.8,
  pending: 0.5,
  askOption: 0.08
};
var DESTRUCTIVE = new Set(["surface:command:action-delete-last-message", "surface:command:action-delete-chat", "lumi:draft_clear"]);
var PHRASES = {
  "lumi:character_open": ["Opening", "open"],
  "lumi:character_chat_latest": ["Opening your chat with", "your chat with"],
  "lumi:character_chat_new": ["Starting a new chat with", "a new chat with"],
  "lumi:chat_open": ["Opening", "the chat"],
  "lumi:persona_switch": ["Switching persona to", "persona"],
  "lumi:preset_switch": ["Switching preset to", "preset"],
  "lumi:theme_apply": ["Applying theme", "theme"],
  "lumi:llm_switch": ["Switching to", "profile"]
};
var DICTATION_PREFIX = /^\s*(?:(?:hey\s+)?lumi\s*[,.!:]?\s*)?(?:(?:please\s+)?(?:write|type|dictate)(?:\s+(?:this|that|down|out))?\s*[,.:]?\s+)?/i;
var EXPLICIT_DICTATION = /^\s*(?:(?:hey\s+)?lumi\s*[,.!:]?\s*)?(?:please\s+)?(?:write|type|dictate)\b/i;
function stripDictationPrefix(utterance) {
  const rest = utterance.replace(DICTATION_PREFIX, "");
  return rest.trim() ? rest.trim() : utterance.trim();
}
function choice(answer) {
  return answer?.type === "choice" ? answer : undefined;
}
function ranked(answer, safe) {
  return Object.entries(answer.probabilities).filter(([key]) => key !== safe).sort((a, b) => b[1] - a[1]);
}
var names = (labels) => labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
function describeStep(step, lookup, form = 0) {
  const candidate = lookup.candidates.find((c) => c.id === step.actionId);
  const kind = candidate?.arg;
  const entity = kind ? lookup.entities[kind]?.find((e) => e.id === step.args[kind]) : undefined;
  const phrase = PHRASES[step.actionId];
  if (entity && phrase)
    return `${phrase[form]} ${entity.name}`;
  if (!candidate)
    return step.actionId;
  if (/^surface:(drawer_tab|settings_tab|route|modal):/.test(candidate.id))
    return form ? candidate.label : `Opening ${candidate.label}`;
  return entity ? `${candidate.label}: ${entity.name}` : candidate.label;
}
var lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
function runResult(steps, confidence, lookup) {
  const confirm = steps.some((s) => DESTRUCTIVE.has(s.actionId) || lookup.candidates.find((c) => c.id === s.actionId)?.destructive === true);
  const say = steps.map((s, i) => i ? lowerFirst(describeStep(s, lookup)) : describeStep(s, lookup)).join(", then ");
  return { kind: "run", steps, say, confirm, confidence };
}
function ask(question, options) {
  return { kind: "ask", pending: { question, options } };
}
function argFor(candidate, plan, answers, entities) {
  if (!candidate.arg)
    return { id: "", p: 1, sure: true };
  const answer = choice(answers[`arg_${candidate.arg}`]);
  const best = answer && ranked(answer, UNCLEAR)[0];
  const entity = best && plan.args[candidate.arg]?.get(best[0]);
  if (!answer || !best || !entity)
    return null;
  const p = best[1];
  const share = p / (1 - (answer.probabilities[UNCLEAR] ?? 0) || 1);
  const scores = entities[candidate.arg] ?? [];
  const mine = scores.find((r) => r.item.id === entity.id)?.score ?? 0;
  const tied = mine > 0 && scores.some((r) => r.item.id !== entity.id && r.score >= mine * 0.98);
  const sure = p >= (tied ? THRESHOLDS.argTied : THRESHOLDS.arg) && share >= THRESHOLDS.argShare;
  return { id: entity.id, p, sure };
}
var stepFor = (candidate, argId) => ({
  actionId: candidate.id,
  args: candidate.arg ? { [candidate.arg]: argId } : {}
});
function askArg(candidate, plan, answers, entities) {
  const kind = candidate.arg;
  const answer = choice(answers[`arg_${kind}`]);
  if (!answer)
    return { kind: "run", steps: [{ actionId: candidate.id, args: {} }], say: candidate.label, confirm: !!candidate.destructive, confidence: 0.5 };
  const likely = ranked(answer, UNCLEAR).filter(([, p], i) => i === 0 || p >= THRESHOLDS.askOption).map(([key]) => plan.args[kind].get(key));
  const scores = entities[kind] ?? [];
  const topScore = scores.find((r) => r.item.id === likely[0].id)?.score ?? 0;
  const tied = scores.filter((r) => topScore > 0 && r.score >= topScore * 0.98).map((r) => r.item);
  const picks = [...new Set([likely[0], ...tied, ...likely])].slice(0, 3);
  return ask(`Did you mean ${names(picks.map((e) => e.name))}?`, picks.map((e) => ({ label: e.name, step: stepFor(candidate, e.id) })));
}
async function viaPlanner(req, lookup, confidence, services) {
  try {
    const steps = await planSteps(req, lookup.candidates, lookup.entities, services);
    if (steps)
      return runResult(steps, confidence, lookup);
  } catch (err) {
    services.log("warn", `planner failed: ${err}`);
  }
  return { kind: "none", say: "Sorry, I don't know how to do that." };
}
function commandResult(plan, answers, entities, lookup) {
  const action = choice(answers.action);
  if (!action || action.confidence < THRESHOLDS.actionAsk)
    return "plan";
  if (action.choice === NO_ACTION && action.confidence >= THRESHOLDS.action)
    return "plan";
  const candidate = plan.actions.get(action.choice);
  if (candidate && action.confidence >= THRESHOLDS.action) {
    const arg = argFor(candidate, plan, answers, entities);
    return arg?.sure ? runResult([stepFor(candidate, arg.id)], Math.min(action.confidence, arg.p), lookup) : askArg(candidate, plan, answers, entities);
  }
  const options = [];
  const top = ranked(action, NO_ACTION).filter(([, p]) => p >= THRESHOLDS.askOption).slice(0, 3);
  for (const [key] of top) {
    const c = plan.actions.get(key);
    const arg = argFor(c, plan, answers, entities);
    if (!arg?.sure)
      continue;
    const step = stepFor(c, arg.id);
    options.push({ label: describeStep(step, lookup, 1), step });
  }
  if (options.length)
    return ask(`Did you mean ${names(options.map((o) => o.label))}?`, options);
  const first = top[0] && plan.actions.get(top[0][0]);
  return first?.arg ? askArg(first, plan, answers, entities) : "plan";
}
async function route(req, services) {
  const narrowedEntities = {};
  for (const [kind, list] of Object.entries(req.entities)) {
    if (list?.length)
      narrowedEntities[kind] = narrowEntities(req.utterance, list);
  }
  const candidates = await narrowCandidates(req.utterance, req.candidates, services);
  const plan = await buildDecision(req, candidates, narrowedEntities, services);
  const answers = await services.decide(plan.input);
  const allEntities = Object.fromEntries(Object.entries(narrowedEntities).map(([k, list]) => [k, list.map((r) => r.item)]));
  const lookup = { candidates: dedupeCandidates(req.candidates), entities: allEntities };
  const pending = choice(answers.pending);
  if (plan.pending && pending && pending.choice !== NO_PENDING && pending.confidence >= THRESHOLDS.pending) {
    return runResult([plan.pending.get(pending.choice).step], pending.confidence, lookup);
  }
  const intent = choice(answers.intent);
  const action = choice(answers.action);
  const sure = intent.confidence >= THRESHOLDS.intent;
  const explicitDictation = EXPLICIT_DICTATION.test(req.utterance);
  if (intent.choice === "close" && intent.confidence >= THRESHOLDS.close)
    return { kind: "close" };
  if (intent.choice === "dictation" && (sure || explicitDictation))
    return { kind: "dictation", text: stripDictationPrefix(req.utterance) };
  if (intent.choice === "not_for_lumi" && sure)
    return { kind: "ignore" };
  const actionSure = action && action.choice !== NO_ACTION && action.confidence >= THRESHOLDS.action;
  if (actionSure || intent.choice === "command" && !explicitDictation) {
    if ((answers.multi?.type === "noul" ? answers.multi.noul : 0) >= THRESHOLDS.multi) {
      return viaPlanner(req, lookup, intent.confidence, services);
    }
    const result = commandResult(plan, answers, narrowedEntities, lookup);
    return result === "plan" ? viaPlanner(req, lookup, intent.confidence, services) : result;
  }
  if (explicitDictation)
    return { kind: "dictation", text: stripDictationPrefix(req.utterance) };
  return intent.choice === "dictation" ? { kind: "none", say: "Sorry, I didn't catch that." } : { kind: "ignore" };
}

// src/backend/router/index.ts
function routeUtterance(req, services) {
  return route(req, services);
}
function pickDomControl(req, services) {
  return pickControl(req, services);
}

// src/shared/host-ext.ts
var CAP = {
  stt: "speech-to-text-v1",
  sttOptions: "speech-to-text-options-v1",
  tts: "text-to-speech-v1",
  composer: "composer-v1",
  connectionKinds: "connection-kinds-v1",
  decisions: "decisions-v1",
  decisionImages: "decision-images-v1",
  embeddings: "embeddings-v1"
};
function hasCap(host, cap) {
  return (host?.capabilities?.[cap] ?? 0) >= 1;
}

// src/backend/services/index.ts
function generationText(result) {
  if (typeof result === "string")
    return result;
  if (!result || typeof result !== "object")
    return "";
  const r = result;
  for (const key of ["content", "text", "output_text"]) {
    if (typeof r[key] === "string")
      return r[key];
  }
  const choice = Array.isArray(r.choices) ? r.choices[0] : undefined;
  if (typeof choice?.message?.content === "string")
    return choice.message.content;
  if (typeof choice?.text === "string")
    return choice.text;
  return "";
}
function createServices(host, settings, userId) {
  const user = userId ? { userId } : {};
  const embeddings = host.embeddings && hasCap(host.host, CAP.embeddings) && host.permissions.has("embeddings") ? host.embeddings : null;
  return {
    async decide(input, options) {
      const result = await host.decisions.evaluate({ ...input, ...user, ...settings.decisionProfile ? { connection_id: settings.decisionProfile } : {} }, options);
      return result.answers;
    },
    decisionImages: hasCap(host.host, CAP.decisionImages) && host.permissions.has("images"),
    async complete(messages, options = {}) {
      const parameters = {};
      if (options.temperature !== undefined)
        parameters.temperature = options.temperature;
      if (options.maxTokens !== undefined)
        parameters.max_tokens = options.maxTokens;
      const result = await host.generate.quiet({
        type: "quiet",
        messages,
        parameters,
        reasoning: { source: "off" },
        ...user,
        ...settings.llmProfile ? { connection_id: settings.llmProfile } : {},
        ...options.signal ? { signal: options.signal } : {}
      });
      return generationText(result);
    },
    embed: embeddings ? async (texts, inputType) => {
      const vectors = [];
      let cacheKey = "";
      let connectionId = settings.embeddingProfile || undefined;
      for (let i = 0;i < texts.length; i += 256) {
        const res = await embeddings.embed({ texts: texts.slice(i, i + 256), input_type: inputType, ...user, ...connectionId ? { connection_id: connectionId } : {} });
        connectionId = res.connection_id;
        cacheKey = `${res.connection_id}:${res.model}`;
        vectors.push(...res.embeddings);
      }
      return { vectors, cacheKey };
    } : null,
    async portraitSize(imageId) {
      const image = await host.images.get(imageId, userId);
      if (image?.mime_type !== "image/png" && image?.mime_type !== "image/jpeg")
        return null;
      return image.width && image.height ? { width: image.width, height: image.height } : null;
    },
    log(level, message) {
      host.log[level](`[hey_lumi] ${message}`);
    }
  };
}

// src/backend/handlers.ts
var BACKEND_KINDS = ["character", "persona", "preset"];
var REWRITE_CONTEXT_MESSAGES = 8;
var MAX_NAMES = 400;
function createHandlers(host, entities, services = (s, u) => createServices(host, s, u)) {
  return {
    async route(req, userId) {
      const needed = new Set(req.candidates.map((c) => c.arg).filter((a) => !!a));
      const filled = { ...req.entities };
      for (const kind of BACKEND_KINDS) {
        if (!needed.has(kind))
          continue;
        const items = await entities.get(kind, userId);
        if (items)
          filled[kind] = kind === "character" ? recentFirst(items, req.context.recentCharacterIds) : items;
      }
      return routeUtterance({ ...req, entities: filled }, services(req.settings, userId));
    },
    domPick: (req, userId) => pickDomControl(req, services(req.settings, userId)),
    dictate: (req, userId) => formatDictation(req, services(req.settings, userId)),
    async rewrite(req, userId) {
      let recent = [];
      if (req.chatId) {
        const messages = await host.chat.getMessages(req.chatId);
        recent = messages.slice(-REWRITE_CONTEXT_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
      }
      return { text: await rewriteDraft(req.draft, recent, services(req.settings, userId)) };
    },
    async listProfiles(_params, userId) {
      const user = userId ? { userId } : undefined;
      const decision = host.permissions.has("decisions") ? (await host.decisions.listConnections(user)).map((c) => ({ id: c.id, name: c.name, isDefault: c.is_default, model: c.model })) : [];
      const embedding = host.embeddings && host.permissions.has("embeddings") ? (await host.embeddings.listConnections(user)).filter((c) => c.enabled).map((c) => ({ id: c.id, name: c.name, isDefault: c.is_primary })) : null;
      return { decision, embedding };
    },
    async listNames(_params, userId) {
      const [characters, personas] = await Promise.all([entities.get("character", userId), entities.get("persona", userId)]);
      return [...new Set([...personas ?? [], ...characters ?? []].map((e) => e.name.trim()).filter(Boolean))].slice(0, MAX_NAMES);
    },
    async settingsTabs(_params, userId) {
      const tabs = await host.ui.getSettingsTabs(userId ? { userId } : undefined);
      return tabs.map((t) => ({ id: t.id, label: t.tabName, description: t.tabDescription, keywords: t.keywords }));
    },
    async openSettings({ id }, userId) {
      await host.ui.openSettings(id, userId ? { userId } : undefined);
      return { ok: true };
    },
    async swipe({ chatId, direction }) {
      const messages = await host.chat.getMessages(chatId);
      const last = messages.findLast((m) => !m.is_user);
      if (!last)
        return { ok: false, say: "There is no reply to swipe." };
      const next = last.swipe_id + (direction === "left" ? -1 : 1);
      if (next < 0)
        return { ok: false, say: "This is already the first swipe." };
      if (next >= last.swipes.length)
        return { ok: false, say: 'This is the last swipe. Say "regenerate" for a new one.' };
      await host.chat.updateMessage(chatId, last.id, { swipe_id: next });
      return { ok: true };
    },
    async switchPersona({ personaId }, userId) {
      await host.personas.switchActive(personaId, userId);
      return { ok: true };
    }
  };
}
function recentFirst(items, recentIds) {
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return [...items].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
}
function isRpcRequest(payload) {
  const p = payload;
  return !!p && p.type === "hey_lumi:req" && typeof p.id === "string" && typeof p.method === "string";
}
function errorResponse(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? "HEY_LUMI_ERROR";
  return { type: "hey_lumi:res", id, ok: false, error: { code, message } };
}
async function handleRpc(handlers, req, userId) {
  const handler = handlers[req.method];
  if (!handler)
    return errorResponse(req.id, new Error(`UNKNOWN_METHOD: ${req.method}`));
  try {
    return { type: "hey_lumi:res", id: req.id, ok: true, result: await handler(req.params, userId) };
  } catch (error) {
    return errorResponse(req.id, error);
  }
}

// src/backend.ts
var entities = createEntityLists(spindle);
var handlers = createHandlers(spindle, entities);
spindle.onFrontendMessage(async (payload, userId, frontendSessionId) => {
  if (!isRpcRequest(payload))
    return;
  const response = await handleRpc(handlers, payload, userId);
  if (!response.ok)
    spindle.log.warn(`[hey_lumi] ${payload.method} failed: ${response.error.message}`);
  spindle.sendToFrontend(response, userId, frontendSessionId ? { frontendSessionId } : undefined);
});
for (const event of ["CHARACTER_CREATED", "CHARACTER_EDITED", "CHARACTER_DELETED", "CHARACTER_LIBRARY_CHANGED", "PERSONA_CHANGED", "PRESET_CHANGED", "PRESET_DELETED"]) {
  try {
    spindle.on(event, () => entities.clear());
  } catch {}
}
