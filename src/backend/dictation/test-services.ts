/** Scripted Services for dictation tests. */
import type { DecisionQuestion } from "lumiverse-spindle-types";
import type { DictationLabel } from "../../shared/protocol";
import type { ChatMessage, Services } from "../services/types";

export interface Script {
  /** Label for a unit text (default narration). */
  label?: (unit: string) => DictationLabel;
  /** Paragraph noul for a unit text (default 0). */
  paragraph?: (unit: string) => number;
  /** Speaker-change noul for a unit text (default 0). */
  speaker?: (unit: string) => number;
  /** Gap noul for the text around a gap ("left words | right words"; default 0). */
  gap?: (text: string) => number;
  /** complete() replies in order; an Error is thrown. */
  replies?: Array<string | Error>;
}

export function scriptedServices(script: Script = {}) {
  const calls = { decide: [] as Record<string, DecisionQuestion>[], complete: [] as ChatMessage[][] };
  const replies = [...(script.replies ?? [])];
  const services: Services = {
    async decide(input) {
      calls.decide.push(input.questions);
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries(input.questions as Record<string, DecisionQuestion>)) {
        const ins = q.instructions as Record<string, string>;
        if (k[0] === "u") answers[k] = { type: "choice", choice: script.label?.(ins.unit!) ?? "narration", confidence: 0.9, probabilities: {} };
        else if (k[0] === "p") answers[k] = { type: "noul", noul: script.paragraph?.(ins.unit!) ?? 0 };
        else if (k[0] === "s") answers[k] = { type: "noul", noul: script.speaker?.(ins.line!) ?? 0 };
        else answers[k] = { type: "noul", noul: script.gap?.(ins.text!) ?? 0 };
      }
      return answers as never;
    },
    decisionImages: false,
    async complete(messages) {
      calls.complete.push(messages);
      const r = replies.shift();
      if (r === undefined) throw new Error("no scripted reply");
      if (r instanceof Error) throw r;
      return r;
    },
    embed: null,
    async imageSize() {
      return null;
    },
    log() {},
  };
  return { services, calls };
}
