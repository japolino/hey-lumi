import type { DictationFormat, RouterSettings } from "./protocol";

/** Lumi Voice settings, stored with `ctx.settings` under SETTINGS_KEY. The frontend owns them and sends what the backend needs. */
export interface LumiVoiceSettings {
  /** Listen for "Hey Lumi" while no session is open. */
  wakeWord: boolean;
  /** Close the session after this many seconds without speech. */
  idleTimeoutSec: number;
  /** Connection profile ids per kind; "" = the Lumiverse default for that kind. */
  profiles: {
    stt: string;
    decision: string;
    llm: string;
    embedding: string;
    tts: string;
  };
  /** Speak short replies ("Opening Theme") with TTS when the host has it. */
  voiceReplies: boolean;
  format: DictationFormat;
}

export const SETTINGS_KEY = "settings";

export const DEFAULT_SETTINGS: LumiVoiceSettings = {
  wakeWord: true,
  idleTimeoutSec: 20,
  profiles: { stt: "", decision: "", llm: "", embedding: "", tts: "" },
  voiceReplies: false,
  format: { thought: "asterisks", quotes: "straight", ooc: "double_parens" },
};

/** Fill missing or wrong-typed fields from the defaults. */
export function normalizeSettings(raw: unknown): LumiVoiceSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const p = (r.profiles && typeof r.profiles === "object" ? r.profiles : {}) as Record<string, unknown>;
  const f = (r.format && typeof r.format === "object" ? r.format : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);
  const d = DEFAULT_SETTINGS;
  return {
    wakeWord: typeof r.wakeWord === "boolean" ? r.wakeWord : d.wakeWord,
    idleTimeoutSec:
      typeof r.idleTimeoutSec === "number" && Number.isFinite(r.idleTimeoutSec) ? Math.min(120, Math.max(5, r.idleTimeoutSec)) : d.idleTimeoutSec,
    profiles: { stt: str(p.stt), decision: str(p.decision), llm: str(p.llm), embedding: str(p.embedding), tts: str(p.tts) },
    voiceReplies: typeof r.voiceReplies === "boolean" ? r.voiceReplies : d.voiceReplies,
    format: {
      thought: pick(f.thought, ["asterisks", "plain"], d.format.thought),
      quotes: pick(f.quotes, ["straight", "curly"], d.format.quotes),
      ooc: pick(f.ooc, ["double_parens", "brackets"], d.format.ooc),
    },
  };
}

export function routerSettings(s: LumiVoiceSettings): RouterSettings {
  return { decisionProfile: s.profiles.decision, llmProfile: s.profiles.llm, embeddingProfile: s.profiles.embedding };
}
