/**
 * Host APIs that are proposed in open Lumiverse PRs but not yet in lumiverse-spindle-types 0.6.52.
 * Every member is optional: feature-detect the member AND its host capability. Shapes follow the PR branches on
 * github.com/japolino/Lumiverse (feat/spindle-composer, feat/spindle-tts, feat/connections-by-kind,
 * feat/parameterized-host-actions, feat/spindle-embeddings, feat/stt-transcribe-options).
 */
import type { SpindleAPI, SpindleFrontendContext, SpindleSTTOptions, SpindleSTTTranscript } from "lumiverse-spindle-types";

export const CAP = {
  stt: "speech-to-text-v1",
  sttOptions: "speech-to-text-options-v1",
  tts: "text-to-speech-v1",
  composer: "composer-v1",
  connectionKinds: "connection-kinds-v1",
  decisions: "decisions-v1",
  decisionImages: "decision-images-v1",
  embeddings: "embeddings-v1",
} as const;

export function hasCap(host: { capabilities?: Readonly<Record<string, number>> } | undefined, cap: string): boolean {
  return (host?.capabilities?.[cap] ?? 0) >= 1;
}

/* ── frontend ─────────────────────────────────────────────────────────────── */

export interface ComposerState {
  mounted: boolean;
  chatId: string | null;
  text: string;
}

/** ctx.composer (composer-v1). Write methods throw COMPOSER_UNAVAILABLE when no composer is mounted. */
export interface ComposerAPI {
  getState(): ComposerState;
  onChange(handler: (state: ComposerState) => void): () => void;
  setText(text: string): void;
  insertText(text: string, options?: { at?: "caret" | "end" }): void;
  focus(): void;
  /** Needs `generation`. Rejects COMPOSER_BUSY while a send/generation runs. */
  send(): Promise<void>;
}

/** ctx.tts (text-to-speech-v1). */
export interface TtsAPI {
  speak(input: { text: string } | { messageId: string }, options?: { connectionId?: string }): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
  subscribe(listener: (speaking: boolean) => void): () => void;
}

export type ConnectionKind = "llm" | "image" | "tts" | "stt" | "embedding" | "decision";

export interface ConnectionSummary {
  id: string;
  kind: ConnectionKind;
  name: string;
  provider: string;
  model: string;
  active: boolean;
  voice?: string;
}

/** ctx.connections as the staging host really has it (list is synchronous there) plus connection-kinds-v1. */
export interface ConnectionsAPI {
  list(options?: { kind?: ConnectionKind }): unknown;
  getActive?(kind?: ConnectionKind): unknown;
  setActive?(id: string | null): void | Promise<void>;
  setActiveAcknowledged?(id: string | null): void | Promise<void>;
}

export interface SttWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

/** Proposed ctx.stt additions (speech-to-text-options-v1). */
export interface SttTranscribeOptionsExt extends SpindleSTTOptions {
  words?: boolean;
  keywords?: string[];
}
export interface SttTranscriptExt extends SpindleSTTTranscript {
  words?: SttWord[];
}
export interface SttApiExt {
  transcribe(audio: Blob | { samples: Float32Array; sampleRate: number }, options?: SttTranscribeOptionsExt): Promise<SttTranscriptExt>;
  listProviders(): Array<{ id: string; available: boolean; supportsAudioTranscription: boolean; onDevice: boolean }>;
  /** Proposed: host mic (composer mic button) recording on/off. */
  onHostActivity?(listener: (active: boolean) => void): () => void;
  isHostCapturing?(): boolean;
}

/** A host surface entry, including the proposed `entity_action` kind and its `params` schema. */
export interface HostSurfaceInfo {
  kind: string;
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  scope?: string;
  role?: string;
  owner?: string;
  invocable?: boolean;
  params?: {
    type: "object";
    properties: Record<string, { type: "string"; description: string; enum?: string[]; oneOf?: Array<{ const: string; title: string }> }>;
    required: string[];
  };
}

export interface HostSurfacesAPI {
  list(kinds?: readonly string[]): HostSurfaceInfo[];
  subscribe(listener: (surfaces: HostSurfaceInfo[]) => void): () => void;
  invoke(ref: { kind: string; id: string }, params?: Record<string, string>): void | Promise<void>;
}

/** The frontend ctx with the optional in-flight members typed loosely. */
export type FrontendCtx = Omit<SpindleFrontendContext, "connections" | "stt" | "host"> & {
  host: SpindleFrontendContext["host"] & { surfaces?: HostSurfacesAPI };
  stt?: SttApiExt;
  tts?: TtsAPI;
  composer?: ComposerAPI;
  connections?: ConnectionsAPI;
};

/* ── backend ──────────────────────────────────────────────────────────────── */

export interface EmbeddingsAPI {
  embed(
    input: { texts: string[]; input_type?: "query" | "passage"; connection_id?: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ embeddings: number[][]; connection_id: string; model: string; dimensions: number }>;
  listConnections(): Promise<Array<{ id: string; name: string; provider: string; model: string; enabled: boolean; is_primary: boolean }>>;
}

export type BackendHost = SpindleAPI & { embeddings?: EmbeddingsAPI };
