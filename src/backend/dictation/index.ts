/**
 * Dictation: code splits the transcript, one Jev request labels units and paragraph breaks, code formats
 * (spec/dictation-bench.md approach J). Owner: dictation worker. Contract only until the implementation lands.
 */
import type { DictateRequest, DictateResult } from "../../shared/protocol";
import type { ChatMessage, Services } from "../services/types";

export async function formatDictation(_req: DictateRequest, _services: Services): Promise<DictateResult> {
  throw new Error("NOT_IMPLEMENTED: formatDictation");
}

/** LLM rewrite of the draft with the last few chat messages as context. */
export async function rewriteDraft(_draft: string, _recent: ChatMessage[], _services: Services): Promise<string> {
  throw new Error("NOT_IMPLEMENTED: rewriteDraft");
}
