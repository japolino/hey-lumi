import type { DecisionAnswer } from "lumiverse-spindle-types";
import type { ActionCandidate, ArgKind, EntityOption, PendingAsk, PlanStep, RouteRequest, RouteResult } from "../../shared/protocol";
import type { Services } from "../services/types";
import { dedupeCandidates, narrowCandidates, narrowEntities } from "./narrow";
import { planSteps } from "./planner";
import { buildDecision, NO_ACTION, NO_PENDING, UNCLEAR, type DecisionPlan, type Ranked } from "./questions";

/** Confidence gates, tuned on scratch/router/eval.ts with jev-preview. */
export const THRESHOLDS = {
  /** Intent below this is treated as unclear. */
  intent: 0.5,
  /** Closing the session needs more certainty than other intents. */
  close: 0.6,
  /** Action at or above this runs; between `actionAsk` and this, Lumi asks. */
  action: 0.5,
  actionAsk: 0.2,
  /** Argument probability needed to run, and its share of the probability that is not "unclear". */
  arg: 0.3,
  argShare: 0.8,
  /** Needed instead of `arg` when another entity matches the spoken words equally well. */
  argTied: 0.9,
  multi: 0.8,
  pending: 0.5,
  /** Options under this probability are not offered in a follow-up question. */
  askOption: 0.08,
};

const DESTRUCTIVE = new Set(["surface:command:action-delete-last-message", "surface:command:action-delete-chat", "lumi:draft_clear"]);

/** [what Lumi says while doing it, how a follow-up question names it] for actions that take an entity. */
const PHRASES: Record<string, [string, string]> = {
  "lumi:character_open": ["Opening the profile of", "the profile of"],
  "lumi:character_chat_latest": ["Opening your chat with", "your chat with"],
  "lumi:character_chat_new": ["Starting a new chat with", "a new chat with"],
  "lumi:chat_open": ["Opening", "the chat"],
  "lumi:persona_switch": ["Switching persona to", "persona"],
  "lumi:preset_switch": ["Switching preset to", "preset"],
  "lumi:theme_apply": ["Applying theme", "theme"],
  "lumi:llm_switch": ["Switching to", "profile"],
};

const DICTATION_PREFIX = /^\s*(?:(?:hey\s+)?lumi\s*[,.!:]?\s*)?(?:(?:please\s+)?(?:write|type|dictate)(?:\s+(?:this|that|down|out))?\s*[,.:]?\s+)?/i;
const EXPLICIT_DICTATION = /^\s*(?:(?:hey\s+)?lumi\s*[,.!:]?\s*)?(?:please\s+)?(?:write|type|dictate)\b/i;

/** Drops a leading "Lumi," / "write" / "type" / "Lumi, write:" prefix; the rest is kept word for word. */
export function stripDictationPrefix(utterance: string): string {
  const rest = utterance.replace(DICTATION_PREFIX, "");
  return rest.trim() ? rest.trim() : utterance.trim();
}

function choice(answer: DecisionAnswer | undefined) {
  return answer?.type === "choice" ? answer : undefined;
}

/** Options of a choice answer, most probable first, without the safe option. */
function ranked(answer: { probabilities: Record<string, number> }, safe: string): Array<[string, number]> {
  return Object.entries(answer.probabilities)
    .filter(([key]) => key !== safe)
    .sort((a, b) => b[1] - a[1]);
}

const names = (labels: string[]) => (labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`);

interface Lookup {
  candidates: ActionCandidate[];
  entities: Partial<Record<ArgKind, EntityOption[]>>;
}

function describeStep(step: PlanStep, lookup: Lookup, form: 0 | 1 = 0): string {
  const candidate = lookup.candidates.find((c) => c.id === step.actionId);
  const kind = candidate?.arg;
  const entity = kind ? lookup.entities[kind]?.find((e) => e.id === step.args[kind]) : undefined;
  const phrase = PHRASES[step.actionId];
  if (entity && phrase) return `${phrase[form]} ${entity.name}`;
  if (!candidate) return step.actionId;
  if (/^surface:(drawer_tab|settings_tab|route|modal):/.test(candidate.id)) return form ? candidate.label : `Opening ${candidate.label}`;
  return entity ? `${candidate.label}: ${entity.name}` : candidate.label;
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function runResult(steps: PlanStep[], confidence: number, lookup: Lookup): RouteResult {
  const confirm = steps.some((s) => DESTRUCTIVE.has(s.actionId) || lookup.candidates.find((c) => c.id === s.actionId)?.destructive === true);
  const say = steps.map((s, i) => (i ? lowerFirst(describeStep(s, lookup)) : describeStep(s, lookup))).join(", then ");
  return { kind: "run", steps, say, confirm, confidence };
}

function ask(question: string, options: PendingAsk["options"]): RouteResult {
  return { kind: "ask", pending: { question, options } };
}

/**
 * Most probable argument for a candidate from the Jev answers, even when "unclear" wins. It is `sure` when its probability is
 * high enough and well ahead of the other entities; a pick that another entity matches just as well lexically
 * ("Gemini" for Gemini Flash and Gemini Pro) needs more.
 */
function argFor(candidate: ActionCandidate, plan: DecisionPlan, answers: Record<string, DecisionAnswer>, entities: Partial<Record<ArgKind, Ranked[]>>) {
  if (!candidate.arg) return { id: "", p: 1, sure: true };
  const answer = choice(answers[`arg_${candidate.arg}`]);
  const best = answer && ranked(answer, UNCLEAR)[0];
  const entity = best && plan.args[candidate.arg]?.get(best[0]);
  if (!answer || !best || !entity) return null;
  const p = best[1];
  const share = p / (1 - (answer.probabilities[UNCLEAR] ?? 0) || 1);
  const scores = entities[candidate.arg] ?? [];
  const mine = scores.find((r) => r.item.id === entity.id)?.score ?? 0;
  const tied = mine > 0 && scores.some((r) => r.item.id !== entity.id && r.score >= mine * 0.98);
  const sure = p >= (tied ? THRESHOLDS.argTied : THRESHOLDS.arg) && share >= THRESHOLDS.argShare;
  return { id: entity.id, p, sure };
}

const stepFor = (candidate: ActionCandidate, argId: string): PlanStep => ({
  actionId: candidate.id,
  args: candidate.arg ? { [candidate.arg]: argId } : {},
});

/** "Did you mean Seo-yeon or Seo-ah?" over the most likely entities for one action, plus names that match as well as the top one. */
function askArg(candidate: ActionCandidate, plan: DecisionPlan, answers: Record<string, DecisionAnswer>, entities: Partial<Record<ArgKind, Ranked[]>>): RouteResult {
  const kind = candidate.arg!;
  const answer = choice(answers[`arg_${kind}`]);
  // No list to pick from (e.g. themes on hosts without apply_theme): let the frontend run it and say what is missing.
  if (!answer) return { kind: "run", steps: [{ actionId: candidate.id, args: {} }], say: candidate.label, confirm: !!candidate.destructive, confidence: 0.5 };
  const likely = ranked(answer, UNCLEAR)
    .filter(([, p], i) => i === 0 || p >= THRESHOLDS.askOption)
    .map(([key]) => plan.args[kind]!.get(key)!);
  const scores = entities[kind] ?? [];
  const topScore = scores.find((r) => r.item.id === likely[0]!.id)?.score ?? 0;
  const tied = scores.filter((r) => topScore > 0 && r.score >= topScore * 0.98).map((r) => r.item);
  const picks = [...new Set([likely[0]!, ...tied, ...likely])].slice(0, 3);
  return ask(
    `Did you mean ${names(picks.map((e) => e.name))}?`,
    picks.map((e) => ({ label: e.name, step: stepFor(candidate, e.id) })),
  );
}

async function viaPlanner(req: RouteRequest, lookup: Lookup, confidence: number, services: Services): Promise<RouteResult> {
  try {
    const steps = await planSteps(req, lookup.candidates, lookup.entities, services);
    if (steps) return runResult(steps, confidence, lookup);
  } catch (err) {
    services.log("warn", `planner failed: ${err}`);
  }
  return { kind: "none", say: "Sorry, I don't know how to do that." };
}

function commandResult(
  plan: DecisionPlan,
  answers: Record<string, DecisionAnswer>,
  entities: Partial<Record<ArgKind, Ranked[]>>,
  lookup: Lookup,
): RouteResult | "plan" {
  const action = choice(answers.action);
  if (!action || action.confidence < THRESHOLDS.actionAsk) return "plan";
  if (action.choice === NO_ACTION && action.confidence >= THRESHOLDS.action) return "plan";
  const candidate = plan.actions.get(action.choice);

  if (candidate && action.confidence >= THRESHOLDS.action) {
    const arg = argFor(candidate, plan, answers, entities);
    return arg?.sure ? runResult([stepFor(candidate, arg.id)], Math.min(action.confidence, arg.p), lookup) : askArg(candidate, plan, answers, entities);
  }

  const options: PendingAsk["options"] = [];
  const top = ranked(action, NO_ACTION).filter(([, p]) => p >= THRESHOLDS.askOption).slice(0, 3);
  for (const [key] of top) {
    const c = plan.actions.get(key)!;
    const arg = argFor(c, plan, answers, entities);
    if (!arg?.sure) continue;
    const step = stepFor(c, arg.id);
    options.push({ label: describeStep(step, lookup, 1), step });
  }
  if (options.length) return ask(`Did you mean ${names(options.map((o) => o.label))}?`, options);
  const first = top[0] && plan.actions.get(top[0][0]);
  return first?.arg ? askArg(first, plan, answers, entities) : "plan";
}

export async function route(req: RouteRequest, services: Services): Promise<RouteResult> {
  const narrowedEntities: Partial<Record<ArgKind, Ranked[]>> = {};
  for (const [kind, list] of Object.entries(req.entities) as Array<[ArgKind, EntityOption[] | undefined]>) {
    if (list?.length) narrowedEntities[kind] = narrowEntities(req.utterance, list);
  }
  const candidates = await narrowCandidates(req.utterance, req.candidates, services);
  const plan = await buildDecision(req, candidates, narrowedEntities, services);
  const answers = (await services.decide(plan.input)) as Record<string, DecisionAnswer>;

  const allEntities = Object.fromEntries(Object.entries(narrowedEntities).map(([k, list]) => [k, list!.map((r) => r.item)]));
  const lookup: Lookup = { candidates: dedupeCandidates(req.candidates), entities: allEntities };

  const pending = choice(answers.pending);
  if (plan.pending && pending && pending.choice !== NO_PENDING && pending.confidence >= THRESHOLDS.pending) {
    return runResult([plan.pending.get(pending.choice)!.step], pending.confidence, lookup);
  }

  const intent = choice(answers.intent)!;
  const action = choice(answers.action);
  const sure = intent.confidence >= THRESHOLDS.intent;
  const explicitDictation = EXPLICIT_DICTATION.test(req.utterance);

  if (intent.choice === "close" && intent.confidence >= THRESHOLDS.close) return { kind: "close" };
  if (intent.choice === "dictation" && (sure || explicitDictation)) return { kind: "dictation", text: stripDictationPrefix(req.utterance) };
  if (intent.choice === "not_for_lumi" && sure) return { kind: "ignore" };
  const actionSure = action && action.choice !== NO_ACTION && action.confidence >= THRESHOLDS.action;
  if (actionSure || (intent.choice === "command" && !explicitDictation)) {
    if ((answers.multi?.type === "noul" ? answers.multi.noul : 0) >= THRESHOLDS.multi) {
      return viaPlanner(req, lookup, intent.confidence, services);
    }
    const result = commandResult(plan, answers, narrowedEntities, lookup);
    return result === "plan" ? viaPlanner(req, lookup, intent.confidence, services) : result;
  }
  if (explicitDictation) return { kind: "dictation", text: stripDictationPrefix(req.utterance) };
  return intent.choice === "dictation" ? { kind: "none", say: "Sorry, I didn't catch that." } : { kind: "ignore" };
}

