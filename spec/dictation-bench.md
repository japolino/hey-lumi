# Dictation bench: can Jev structure spoken RP dictation?

Date: 2026-10-18. Bench dir: `C:/Users/eme4/lumi-voice/scratch/dictation-bench/`
(items.json, items_hard.json, splits.json, outputs.json, summaries.json, cache/ = raw Jev and LLM responses).
All numbers below come from real runs: Jev System One at api.typesafe.ai, Gemini through the local CLIProxyAPI
(localhost:8317, OpenAI-style API). No Lumiverse code was run; this tests the method, not an extension.

## Short answer

Yes. Approach J (code splits, one Jev request labels, code formats) works well on punctuated speech-to-text:
**100% word label accuracy on the 12 held-out items, 96.7-97.1% on 8 long messy items, about 0.35 s, about $0.10-0.25 per 1,000 dictations.**
Every word is kept, because code only adds marks.
Unpunctuated text is the hard part. Jev alone cannot find sentence ends well. A tiny LLM pass that only adds
punctuation (code checks that the words did not change), followed by J, gets close to the punctuated result.

## Data

- 40 main dictations (1,190 words) that I wrote to look like ASR output: first and third person, spoken dialogue
  with and without tags ("she says"), tagged and untagged thoughts, OOC at the start, middle and end
  ("uh, OOC, can we skip to night"), fillers (uh, um, like, you know), false starts ("I, I grab"), reported speech
  ("I tell her that I'm fine" = narration), and traps ("I think we should go back" = dialogue).
  Labels by word: action/narration 716, dialogue 241, OOC 151, thought 82. 22 gold paragraph breaks (about half are OOC edges).
- Split: dev 28 items (used for all tuning), held-out 12 (run once at the end): r04, r05, r07, r10, r17, r21, r24, r26, r30, r34, r35, r37.
- 8 extra "hard" items (73-121 words, 695 words total), added after dev and held-out: longer, NPC lines,
  "she just goes, ...", untagged inner thoughts, a few ASR mishearings (canon, Hail, swore, Edrick).
  Labels: action 428, dialogue 136, OOC 77, thought 54.
- Each item has two variants: a punctuated one (Whisper style: commas and periods, no quote marks) and the same words
  lowercase with no punctuation.
- Gold is mine (one author, no second labeller). Paragraph breaks are a matter of taste. Gold rule: OOC is always its own
  paragraph; otherwise a break for a new event, a time skip, or narration picking up after an exchange.

## Method J (what was tested)

1. Code splits the text into units: sentence ends (. ? !), commas, and after speech or thought tags with a subject
   ("I say", "she whispers", "I think to myself"). Units made only of filler words ("Uh,", "Oh wait,", "So, um,")
   are merged into the next unit. Splitting too finely is fine, because neighbouring units with the same label merge back.
2. One Jev request: one `choice` per unit (options in this order: narration (the safe default) / dialogue / thought / ooc,
   with short descriptions). The state holds the numbered transcript; each question also holds the unit text and its
   neighbours. One `noul` per sentence start asks "new paragraph here?".
3. Code formats each run of same-label units: dialogue in "quotes", thought in *asterisks*, OOC in ((...)).
   OOC always gets its own paragraph (code rule). Other breaks: noul > 0.35 (tuned on dev).
4. Small code rules: a bare tag unit ("I think.", "she says") is narration, and a dialogue run just before a think tag
   becomes thought. Then two rules found on the hard set (*): "I'm thinking" counts as a think tag, and a short unit
   (3 words or fewer, not a tag) between two units with the same label inside one sentence takes that label.
   The (*) rules did not change any dev or held-out number.

For unpunctuated input I tried:
- (a) tag splits only. This fails: 65% on dev, because units are too long.
- (b) Jev `noul` per word gap ("does a sentence start after the bar?", 8 words left and 6 right). AUC is only 0.82;
  at threshold 0.2 it finds 95% of sentence starts at precision 0.17. That over-split feeds J. Code moves a cut that
  would end a unit on "i / the / and ..." one word back. Two Jev requests.
- (c) Jev `choice` per word (label every word directly): 92% on dev, dialogue recall 0.72.
- (d) gemini-3.5-flash-lite adds punctuation only. Code strips any quote marks or asterisks it adds and checks that the
  word list is unchanged. If the words changed, or there is almost no punctuation, it falls back to (b). Then J runs as usual.

LLM-only formatter (for comparison): one prompt asks the model to keep every word and use the same marks
(quotes, *thought*, ((OOC)), blank-line paragraphs). Tested with gemini-3.5-flash-lite and gemini-3.8-flash-high, temperature 0.
Scoring is the same for every approach: parse the formatted text back to (word, label, paragraph start), align it to the
gold words with difflib, and score labels per word. Missing words count as wrong.

## Results

### Dev (28 items, used for tuning)
| Approach | Word label acc | Items fully right | Recall dialogue / thought / OOC (%) | Para F1 (P/R) | Items with words exact |
|---|---|---|---|---|---|
| J, Jev 1.13, punctuated | 99.3% | 93% | 100 / 100 / 100 | 0.72 (0.82/0.64) | 100% |
| **J, Jev 1.14, punctuated** | 99.6% | 96% | 100 / 100 / 100 | 0.86 (0.86/0.86) | 100% |
| J, Jev 1.13 gap nouls, unpunctuated | 96.8% | 57% | 95 / 86 / 97 | 0.55 (0.47/0.64) | 100% |
| J, gaps 1.13 + labels 1.14, unpunct. | 95.5% | 57% | 93 / 86 / 92 | 0.56 (0.50/0.64) | 100% |
| J, flash-lite punct + Jev 1.13, unpunct. | 98.2% | 82% | 96 / 100 / 100 | 0.69 (0.75/0.64) | 100% |
| **J, flash-lite punct + Jev 1.14, unpunct.** | 98.6% | 89% | 96 / 100 / 100 | 0.83 (0.80/0.86) | 100% |
| LLM-only flash-lite, punctuated | 97.3% | 82% | 94 / 86 / 100 | 0.42 (0.28/0.86) | 96% |
| LLM-only flash-lite, unpunct. | 96.3% | 61% | 97 / 91 / 94 | 0.27 (0.18/0.50) | 79% |
| LLM-only 3.8 flash high, punctuated | 100.0% | 100% | 100 / 100 / 100 | 0.67 (0.50/1.00) | 100% |
| LLM-only 3.8 flash high, unpunct. | 100.0% | 100% | 100 / 100 / 100 | 0.68 (0.52/1.00) | 100% |

### Held-out (12 items, run once)
| Approach | Word label acc | Items fully right | Recall dialogue / thought / OOC (%) | Para F1 (P/R) | Items with words exact |
|---|---|---|---|---|---|
| J, Jev 1.13, punctuated | 99.4% | 92% | 100 / 100 / 100 | 0.80 (0.86/0.75) | 100% |
| **J, Jev 1.14, punctuated** | 100.0% | 100% | 100 / 100 / 100 | 0.93 (1.00/0.88) | 100% |
| J, Jev 1.13 gap nouls, unpunctuated | 98.0% | 67% | 96 / 100 / 97 | 0.48 (0.38/0.62) | 100% |
| J, gaps 1.13 + labels 1.14, unpunct. | 98.3% | 67% | 96 / 100 / 97 | 0.57 (0.46/0.75) | 100% |
| J, flash-lite punct + Jev 1.13, unpunct. | 98.8% | 92% | 100 / 90 / 100 | 0.80 (0.86/0.75) | 100% |
| **J, flash-lite punct + Jev 1.14, unpunct.** | 98.8% | 92% | 100 / 90 / 100 | 0.88 (0.88/0.88) | 100% |
| LLM-only flash-lite, punctuated | 92.7% | 58% | 83 / 77 / 97 | 0.67 (0.54/0.88) | 92% |
| LLM-only flash-lite, unpunct. | 90.1% | 67% | 44 / 100 / 97 | 0.53 (0.45/0.62) | 92% |
| LLM-only 3.8 flash high, punctuated | 100.0% | 100% | 100 / 100 / 100 | 0.84 (0.73/1.00) | 100% |
| LLM-only 3.8 flash high, unpunct. | 100.0% | 100% | 100 / 100 / 100 | 0.84 (0.73/1.00) | 100% |

### Hard (8 long, messy items, added afterwards)
| Approach | Word label acc | Items fully right | Recall dialogue / thought / OOC (%) | Para F1 (P/R) | Items with words exact |
|---|---|---|---|---|---|
| J, Jev 1.13, punctuated | 95.0% | 50% | 100 / 67 / 100 | 0.70 (0.78/0.64) | 100% |
| J, Jev 1.14, punctuated | 95.8% | 62% | 100 / 78 / 100 | 0.73 (0.73/0.73) | 100% |
| J, Jev 1.13 gap nouls, unpunct. | 87.1% | 12% | 82 / 26 / 95 | 0.39 (0.30/0.55) | 100% |
| J, gaps 1.13 + labels 1.14, unpunct. | 87.8% | 25% | 82 / 39 / 95 | 0.41 (0.30/0.64) | 100% |
| J, flash-lite punct + Jev 1.14, unpunct. | 95.7% | 38% | 100 / 59 / 99 | 0.61 (0.58/0.64) | 100% |
| LLM-only flash-lite, punctuated (h05 blocked) | 84.0% | 38% | 88 / 57 / 81 | 0.45 (0.30/0.91) | 88% |
| LLM-only flash-lite, unpunct. | 90.8% | 0% | 77 / 48 / 96 | 0.29 (0.18/0.64) | 75% |
| LLM-only 3.8 flash high, punctuated (h05 blocked) | 86.9% | 75% | 88 / 63 / 100 | 0.52 (0.40/0.73) | 88% |
| LLM-only 3.8 flash high, unpunct. | 97.4% | 50% | 100 / 78 / 99 | 0.50 (0.36/0.82) | 100% |
| LLM-only 3.8 flash high, punctuated, without h05 | 98.9% | 86% | 100 / 83 / 100 | 0.53 (0.40/0.80) | 100% |
| J, Jev 1.14, punctuated + 2 new rules* | 97.1% | 62% | 100 / 91 / 100 | 0.73 (0.73/0.73) | 100% |
| J, flash-lite + Jev 1.14, unpunct. + 2 new rules* | 96.7% | 50% | 100 / 69 / 99 | 0.61 (0.58/0.64) | 100% |

(*) After the two rules found on this same set, so these two rows are not a clean test.

### Latency and cost
| Approach | Latency p50 / p90 | Jev input tokens / item | LLM tokens in / out per item | Cost per 1,000 dictations |
|---|---|---|---|---|
| J, Jev 1.14, punctuated (40 main) | 0.39 s / 0.62 s | 2209 | - | $0.09 |
| J, flash-lite punct + Jev (40 main) | 1.68 s / 6.51 s | 2350 | 95 / 39 | $0.12 |
| J, Jev gap nouls (2 requests) (40 main) | 0.76 s / 0.90 s | 7275 | - | $0.31 |
| LLM-only flash-lite (40 main) | 1.11 s / 3.54 s | 0 | 232 / 42 | $0.04 |
| LLM-only 3.8 flash high (40 main) | 8.09 s / 11.46 s | 0 | 232 / 1025 | $2.63 |
| J, Jev 1.14, punctuated (8 hard, ~87 words) | 0.33 s / 0.37 s | 5405 | - | $0.23 |
| J, flash-lite punct + Jev (8 hard, ~87 words) | 1.35 s / 1.45 s | 5200 | 160 / 112 | $0.28 |
| J, Jev gap nouls (2 requests) (8 hard, ~87 words) | 0.73 s / 0.86 s | 23650 | - | $0.99 |
| LLM-only flash-lite (8 hard, ~87 words) | 1.12 s / 1.17 s | 0 | 307 / 127 | $0.08 |
| LLM-only 3.8 flash high (8 hard, ~87 words) | 13.00 s / 27.61 s | 0 | 307 / 2502 | $6.35 |

- Jev cost uses $0.042 per M input tokens (stored note from earlier work). Output tokens (about 350-900 per item) are not
  priced; I found no pricing page in the docs.
- Gemini prices are ASSUMED (flash-lite $0.10 / $0.40 per M, 3.8 flash high $0.30 / $2.50 per M, thinking counted as output).
  CLIProxyAPI latency includes the proxy. The flash-lite p90 of 6.5 s came from slow proxy answers during the held-out run.
- Scaling (run): a 382-word dictation (72 units + 41 paragraph nouls) is one Jev request: 24.5k input tokens, 0.36 s.
  So the 64k-token request limit is near 1,000 words. Longer dictations need chunking by paragraph.

## Failure examples (from the runs)

- Untagged inner thought vs. narration or speech (the main remaining error type for every approach).
  Hard h02, J: `I wait, *because I know if I push she'll just shut down.*` (gold: narration).
  h08: `*I hate that she's right.*` (gold: narration; Gemini 3.8 made the same choice). h03: `"We don't have thirty seconds."`
  (gold: thought). Several of these are defensible readings.
- Before the tag rule: `"Great, just great, I think. Well, looks like we're walking," I say` (r18): Jev labeled the bare
  tag "I think." as dialogue, so one quote swallowed thought + tag + speech. Fixed by the bare-tag rule.
- Filler units alone: `"Uh," ¶ ((OOC, can we skip...))` (r03), `"Um," I, I grab the rope` (r06). Fixed by merging filler units.
- Clause edges: `((... rules of the setting? If it's fine,)) ¶ I raise my hand` (r16): the comma unit "If it's fine," went to OOC.
- Unpunctuated, Jev gap nouls: cuts land one word off: `"so you're the new captain you look younger than i expected i" cross my arms` (r08).
- Unpunctuated, flash-lite punctuation: once (r33) it returned the text with no punctuation, so the Jev gap-noul fallback ran.
  Once it added quote marks itself (r11; code now strips them). `I smile and take her hand, lead the way.` (r28): a comma instead of
  a period made "lead the way" narration.
- LLM-only flash-lite: changes or drops words (only 75-92% of items keep the words exactly). It sometimes skips formatting
  (r21: `i hand him the sword careful it's heavier than it looks`). Dialogue recall on held-out unpunctuated was 0.44.
- LLM-only Gemini 3.8 flash high: labels about as good as J or better. But it adds paragraph breaks far more often than the gold
  (precision 0.36-0.73). It takes 8-16 s at p50 and up to 28 s at p90 for an 87-word dictation.
  The proxy returned empty choices for h05 (a crime scene with a body) for both Gemini models on the punctuated variant,
  so that item had no output.
- Formatter gap not covered by the score: two lines from different speakers back to back become one quote
  (`"Captain wants an update by noon. Tell the captain he'll get it when I have something," Hail says`). Probe (run): a Jev noul
  "is the next sentence said by a different character?" at all 24 dialogue-to-dialogue sentence boundaries gave both real
  changes >= 0.73, with one false positive (0.84, r22 "You look, um, wow. / Hi."). The sample is too small to tune; it looks worth adding.

## Recommendation

1. Build Part 2 as approach J with Jev 1.14 (`jev-preview` answered as jev-1.14.0): code segmentation + filler merge,
   one Jev request (unit choices + paragraph nouls, threshold about 0.35), forced OOC paragraphs, the small tag and smoothing
   rules, and code formatting. With Jev 1.13 the numbers are a bit lower (99.3-99.4% punctuated; paragraph F1 0.72-0.80).
   Check which model spindle.decisions lets an extension pick.
2. Prefer a punctuating STT setting (Whisper punctuates by default). If the transcript has no punctuation, run one cheap
   punctuation-only pass with the user's LLM profile (spindle.generate). Code must check that the words are unchanged and
   strip any marks the LLM adds. Fall back to Jev gap nouls (worse: 87-88% on hard items, F1 about 0.4 for paragraphs).
3. Do not use an LLM-only formatter as the default. A small model changes words and mislabels; a strong one is as accurate
   but 20-40x slower (8-16 s) and roughly 10-30x more expensive, and content filters can return nothing.
   It fits the optional "Rewrite" button.
4. Add a speaker-change noul inside dialogue runs (close and reopen quotes). Keep fillers by default ("the user's words are kept
   exactly"; fillers like "Uh, hi" can be in-character speech).
5. Low Jev choice confidence could highlight units for the user, but that was not tested.

## Notes, assumptions, and what I did not verify

- API gotcha (run): the question field is `instructions` (plural). With `instruction` Jev gives no error; it just ignores
  the text (an obvious OOC test came back as noul 0.45; 0.99 after the fix).
- I merged the design's "action" and "narration" into one label, because they format the same way.
- Constants chosen on dev: paragraph noul threshold 0.35, gap-noul threshold 0.2, gap window 8 left / 6 right, filler list,
  a flash-lite punctuation check of at least 1 sentence mark per 25 words.
- The dataset is small and written by one person (me). It is cleaner than real speech: no long pauses, few ASR errors, no crosstalk.
  Gemini 3.8 at 100% on the main set means the main set is too easy to separate it from J; the hard set separates them a little.
- Not run: anything inside Lumiverse (spindle.decisions, spindle.generate, STT). The bench code is in a REPL session, not a
  committed script. Raw requests and responses are in cache/ (Jev keyed by request hash).
