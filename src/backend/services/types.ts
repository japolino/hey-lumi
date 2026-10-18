import type { DecisionAnswers, DecisionImageAsset, DecisionQuestion, DecisionState } from "lumiverse-spindle-types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * What the router and the dictation pipeline may use. Built per request from the frontend's profile settings,
 * so these modules never touch `spindle` directly (tests pass fakes).
 */
export interface Services {
  /** One Jev request (spindle.decisions.evaluate) with the user's Decision profile. */
  decide<const Q extends Record<string, DecisionQuestion>>(
    input: { state: DecisionState; questions: Q; assets?: Record<string, DecisionImageAsset> },
    options?: { signal?: AbortSignal },
  ): Promise<DecisionAnswers<Q>>;
  /** True when Jev image options can be sent (decision-images-v1 and the images permission). */
  readonly decisionImages: boolean;
  /** One LLM completion (spindle.generate) with the user's LLM profile; returns the text. */
  complete(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<string>;
  /**
   * Embed texts with the user's embedding profile, or null when the host has no embeddings API (embeddings-v1).
   * `cacheKey` identifies connection + model: vectors with different keys are not comparable.
   */
  readonly embed: ((texts: string[], inputType: "query" | "passage") => Promise<{ vectors: number[][]; cacheKey: string }>) | null;
  /** Pixel size of a stored image, or null when unknown (Jev rejects image sides under 280 px or over 1568 px). */
  imageSize(imageId: string): Promise<{ width: number; height: number } | null>;
  log(level: "info" | "warn" | "error", message: string): void;
}
