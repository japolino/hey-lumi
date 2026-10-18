import type { ActionCandidate, ArgKind, EntityOption, PlanStep, RouteRequest } from "../../shared/protocol";
import type { Services } from "../services/types";
import { nameStrength, normalize } from "./fuzzy";
import { narrowEntities } from "./narrow";

const MAX_STEPS = 6;
const MIN_NAME_MATCH = 0.7;

const SYSTEM = `You plan actions for Lumi, a voice assistant in the Lumiverse roleplay chat app.
Turn the user's spoken request (speech recognition may mishear words) into steps, using only the listed actions.
Reply with only a JSON array, e.g. [{"actionId":"lumi:persona_switch","args":{"persona":"Ava"}}].
"args" has one name for the argument kind an action needs (from the listed names), and is {} otherwise.
Reply [] if the listed actions cannot do the request.`;

/** Resolves a planner's argument (an id or a possibly misspelt name) to an entity id. */
export function resolveEntity(value: string, entities: EntityOption[]): string | null {
  const exact = entities.find((e) => e.id === value) ?? entities.find((e) => normalize(e.name) === normalize(value));
  if (exact) return exact.id;
  const best = narrowEntities(value, entities, 1)[0];
  return best && best.score > 0 && nameStrength(value, best.item.name) >= MIN_NAME_MATCH ? best.item.id : null;
}

/** Checks the planner's JSON: known action ids only, every needed argument resolved. Returns null for any invalid plan. */
export function validatePlan(text: string, candidates: ActionCandidate[], entities: Partial<Record<ArgKind, EntityOption[]>>): PlanStep[] | null {
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) return null;
  const steps: PlanStep[] = [];
  for (const item of raw) {
    const candidate = candidates.find((c) => c.id === item?.actionId);
    if (!candidate) return null;
    const step: PlanStep = { actionId: candidate.id, args: {} };
    if (candidate.arg) {
      const value = item.args?.[candidate.arg];
      const id = typeof value === "string" ? resolveEntity(value, entities[candidate.arg] ?? []) : null;
      if (!id) return null;
      step.args[candidate.arg] = id;
    }
    steps.push(step);
  }
  return steps;
}

/** Asks the LLM for a step list and validates it. */
export async function planSteps(
  req: RouteRequest,
  candidates: ActionCandidate[],
  entities: Partial<Record<ArgKind, EntityOption[]>>,
  services: Services,
): Promise<PlanStep[] | null> {
  const actions = candidates.map((c) => `${c.id} | ${c.label}${c.description ? ` - ${c.description}` : ""}${c.arg ? ` | arg: ${c.arg}` : ""}`);
  const names = Object.entries(entities)
    .filter(([, list]) => list?.length)
    .map(([kind, list]) => `${kind}: ${list!.map((e) => e.name).join(", ")}`);
  const { context } = req;
  const user = [
    "Actions:",
    ...actions,
    "",
    "Names:",
    ...names,
    "",
    `Screen: route ${context.route}, chat ${context.chatOpen ? "open" : "not open"}, draft ${context.draft ? "has text" : "empty"}.`,
    `Request: "${req.utterance}"`,
  ].join("\n");
  const text = await services.complete(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: user },
    ],
    { temperature: 0, maxTokens: 400 },
  );
  return validatePlan(text, candidates, entities);
}
