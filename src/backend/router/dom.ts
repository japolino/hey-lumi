import type { DomPickRequest, DomPickResult } from "../../shared/protocol";
import type { Services } from "../services/types";

export const DOM_THRESHOLD = 0.4;
const NONE = "none";

export async function pickControl(req: DomPickRequest, services: Services): Promise<DomPickResult> {
  if (!req.controls.length) return { controlId: null, confidence: 0 };
  const keys = new Map<string, string>();
  const criteria: Record<string, string | null> = { [NONE]: "No visible control does what the user asked." };
  for (const c of req.controls) {
    const base = (c.label.replace(/\s+/g, " ").trim().slice(0, 80) || c.role);
    let key = base;
    for (let n = 2; key.toLowerCase() === NONE || keys.has(key); n++) key = `${base} (${n})`;
    keys.set(key, c.id);
    criteria[key] = c.context ? `${c.role} in "${c.context}"` : c.role;
  }
  const { pick } = await services.decide({
    state: { utterance: req.utterance },
    questions: {
      pick: {
        type: "choice",
        instructions:
          "The user asked the voice assistant `utterance` (speech recognition may mishear words). Which visible control on the screen should be clicked to do it?",
        criteria,
      },
    },
  });
  const controlId = pick.choice !== NONE && pick.confidence >= DOM_THRESHOLD ? keys.get(pick.choice)! : null;
  return { controlId, confidence: pick.confidence };
}
