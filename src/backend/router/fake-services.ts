/** Scripted Services for router tests. */
import type { DecisionAnswer, DecisionQuestion } from "lumiverse-spindle-types";
import type { ActionCandidate, EntityOption, RouteRequest } from "../../shared/protocol";
import { LUMI_ACTIONS } from "../../shared/protocol";
import type { ChatMessage, Services } from "../services/types";

type DecideInput = Parameters<Services["decide"]>[0];

/** A choice answer from probabilities (missing options get 0). */
export function pick(probabilities: Record<string, number>): DecisionAnswer {
  const [choice, peak] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  return { type: "choice", choice, confidence: peak, probabilities };
}

export const noul = (p: number): DecisionAnswer => ({ type: "noul", noul: p });

export interface FakeOptions {
  /** Scripted answers by question id; unscripted choices pick their first (safe) option, nouls answer 0. */
  answers?: Record<string, DecisionAnswer> | ((input: DecideInput) => Record<string, DecisionAnswer>);
  plan?: string;
  embed?: Services["embed"];
  decisionImages?: boolean;
  imageSize?: { width: number; height: number } | null;
}

export function fakeServices(options: FakeOptions = {}) {
  const decided: DecideInput[] = [];
  const completed: ChatMessage[][] = [];
  const services: Services = {
    async decide(input) {
      decided.push(input);
      const scripted = typeof options.answers === "function" ? options.answers(input) : (options.answers ?? {});
      const out: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(input.questions) as Array<[string, DecisionQuestion]>) {
        if (scripted[id]) out[id] = scripted[id]!;
        else if (q.type === "choice") out[id] = pick({ [Object.keys(q.criteria)[0]!]: 1 });
        else out[id] = noul(0);
      }
      return out as never;
    },
    decisionImages: options.decisionImages ?? false,
    async complete(messages) {
      completed.push(messages);
      return options.plan ?? "[]";
    },
    embed: options.embed ?? null,
    async imageSize() {
      return options.imageSize === undefined ? { width: 512, height: 512 } : options.imageSize;
    },
    log() {},
  };
  return { services, decided, completed };
}

export const lumiCandidates: ActionCandidate[] = Object.entries(LUMI_ACTIONS).map(([id, a]) => ({ id, ...a }));

export const surfaceCandidates: ActionCandidate[] = [
  { id: "surface:drawer_tab:theme", label: "Theme", description: "Customize colors, accent, and visual style", keywords: ["theme", "colors"] },
  { id: "surface:command:panel-theme", label: "Theme", description: "Customize colors, accent, and visual style", keywords: ["theme"] },
  { id: "surface:drawer_tab:lorebook", label: "Lorebook", description: "Edit world book and lorebook entries", keywords: ["lorebook", "world", "lore", "book"] },
  { id: "surface:drawer_tab:connections", label: "Connections", description: "Manage API connections and providers", keywords: ["api", "claude", "gemini"] },
  { id: "surface:settings_tab:voice", label: "Voice & Speech", description: "Text-to-speech, speech-to-text, and voice settings", keywords: ["voice", "tts"] },
  { id: "surface:command:action-regenerate", label: "Regenerate Response", description: "Generate a new reply", keywords: ["regenerate", "retry"] },
  { id: "surface:command:action-delete-chat", label: "Delete Chat", description: "Permanently delete this conversation", keywords: ["delete", "chat"] },
];

const e = (id: string, name: string, imageId?: string): EntityOption => ({ id, name, ...(imageId ? { imageId } : {}) });

export const testEntities = {
  character: [e("c1", "Seo-yeon", "i1"), e("c2", "Seo-ah", "i2"), e("c3", "Mira", "i3"), e("c4", "Kael", "i4")],
  persona: [e("p1", "Ava"), e("p2", "Eve")],
  llm_profile: [e("l1", "Claude Sonnet"), e("l2", "Gemini Flash"), e("l3", "Gemini Pro")],
};

export function request(utterance: string, extra: Partial<RouteRequest> = {}): RouteRequest {
  return {
    utterance,
    context: { route: "/", chatOpen: false, generating: false, draft: "", history: [] },
    candidates: [...surfaceCandidates, ...lumiCandidates],
    entities: testEntities,
    settings: { decisionProfile: "", llmProfile: "", embeddingProfile: "" },
    ...extra,
  };
}
