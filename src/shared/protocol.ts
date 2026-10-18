/**
 * Contract between the Lumi Voice frontend (mic, bubble, action execution) and backend (Jev, LLM, embeddings,
 * entity lists). Plain JSON only: everything here crosses `ctx.sendToBackend` / `spindle.sendToFrontend`.
 */

/* ── Actions the frontend can run ─────────────────────────────────────────── */

/** Entity kinds an action argument can refer to. */
export type ArgKind = "character" | "persona" | "preset" | "theme" | "llm_profile" | "chat";

/** One pickable entity (a character, a theme, a recent chat ...). */
export interface EntityOption {
  id: string;
  name: string;
  /** Short extra text for matching and for Jev (e.g. a character's tags or a chat's character name). */
  detail?: string;
  /** Stored Lumiverse image (characters, personas); lets Jev match by looks. */
  imageId?: string;
}

/**
 * One thing Lumi can do, offered to the router. Ids:
 * - `surface:<kind>:<id>`: a host surface from `ctx.host.surfaces.list()`, run with `invoke({kind, id})`.
 * - `lumi:<name>`: an action Lumi Voice implements itself (see `LUMI_ACTIONS`).
 */
export interface ActionCandidate {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  /** The one entity argument this action needs (its id goes in `args[arg]`). */
  arg?: ArgKind;
  /** Deletes or overwrites user data: always confirm before running. */
  destructive?: boolean;
}

/** Lumi Voice's own actions. The frontend offers only those it can run right now. */
export const LUMI_ACTIONS = {
  "lumi:character_open": { label: "Open character", description: "Open a character's profile page", arg: "character" },
  "lumi:character_chat_latest": { label: "Chat with character", description: "Open the most recent chat with a character", arg: "character" },
  "lumi:character_chat_new": { label: "New chat with character", description: "Start a new chat with a character", arg: "character" },
  "lumi:chat_open": { label: "Open chat", description: "Open one of the recent chats", arg: "chat" },
  "lumi:persona_switch": { label: "Switch persona", description: "Make a persona the active persona", arg: "persona" },
  "lumi:preset_switch": { label: "Switch preset", description: "Make a preset the active preset", arg: "preset" },
  "lumi:theme_apply": { label: "Apply theme", description: "Apply a theme (colors and style)", arg: "theme" },
  "lumi:llm_switch": { label: "Switch connection profile", description: "Switch the active LLM connection profile", arg: "llm_profile" },
  "lumi:swipe_left": { label: "Previous swipe", description: "Show the previous swipe of the last reply" },
  "lumi:swipe_right": { label: "Next swipe", description: "Show the next swipe of the last reply, or generate a new one" },
  "lumi:stop": { label: "Stop", description: "Stop the reply that is being generated; when nothing is generated, close Lumi" },
  "lumi:close": { label: "Close Lumi", description: "End the voice session; Lumi waits for \"Hey Lumi\" again" },
  "lumi:stop_listening": { label: "Stop listening", description: "Turn Lumi's microphone off until it is turned on again" },
  "lumi:draft_send": { label: "Send the draft", description: "Send the message in the chat input" },
  "lumi:draft_rewrite": { label: "Rewrite the draft", description: "Rewrite the message in the chat input with the AI, using recent chat context" },
  "lumi:draft_clear": { label: "Clear the draft", description: "Empty the chat input", destructive: true },
  "lumi:draft_read": { label: "Read the draft aloud", description: "Read the message in the chat input aloud" },
  "lumi:undo": { label: "Undo", description: "Undo Lumi's last change to the draft" },
  "lumi:screen_control": { label: "Something on screen", description: "A button or control visible on screen that is not listed here" },
} as const satisfies Record<string, { label: string; description: string; arg?: ArgKind; destructive?: boolean }>;

export type LumiActionId = keyof typeof LUMI_ACTIONS;

/* ── Router ───────────────────────────────────────────────────────────────── */

/** What the frontend knows about the page when the utterance arrives. */
export interface RouteContext {
  /** e.g. "/chat/abc", "/", "/characters". */
  route: string;
  chatOpen: boolean;
  generating: boolean;
  /** Chat composer text right now ("" when empty or unknown). */
  draft: string;
  /** Short history of this session, oldest first: what the user said and what Lumi did. */
  history: Array<{ said: string; did: string }>;
  /** The bubble's current line (what Lumi last said, e.g. "Opening Theme"). */
  lumiSaid: string;
  /** Characters of the most recent chats, newest first (the backend lists these characters first). */
  recentCharacterIds: string[];
}

/** A follow-up question the bubble asked; the next utterance answers it. */
export interface PendingAsk {
  question: string;
  options: Array<{ label: string; step: PlanStep }>;
}

export interface PlanStep {
  actionId: string;
  /** Argument ids by ArgKind, e.g. `{ character: "c1" }`. */
  args: Partial<Record<ArgKind, string>>;
}

export interface RouteRequest {
  utterance: string;
  context: RouteContext;
  candidates: ActionCandidate[];
  /** Entity lists only the frontend has (themes, LLM profiles, recent chats). The backend adds characters, personas, presets. */
  entities: Partial<Record<ArgKind, EntityOption[]>>;
  pending?: PendingAsk;
  settings: RouterSettings;
}

export interface RouterSettings {
  /** Decision connection id ("" = host default). */
  decisionProfile: string;
  /** LLM connection id for the planner ("" = host default). */
  llmProfile: string;
  /** Embedding connection id ("" = host default); used only when the host has embeddings-v1. */
  embeddingProfile: string;
}

export type RouteResult =
  /** End the voice session. */
  | { kind: "close" }
  /** Not meant for Lumi (talking to someone else, noise). Do nothing. */
  | { kind: "ignore" }
  /** Dictate `text` into the composer (wake words / "write ..." prefixes already removed). */
  | { kind: "dictation"; text: string }
  /** Run steps in order; stop at the first failure. One step for a normal command. */
  | {
      kind: "run";
      steps: PlanStep[];
      /** Human summary for the bubble, e.g. "Opening Theme". */
      say: string;
      /** True when any step is destructive: the frontend must confirm first. */
      confirm: boolean;
      confidence: number;
    }
  /** Ask a short follow-up; the frontend shows it and sends the answer with `pending`. */
  | { kind: "ask"; pending: PendingAsk }
  /** Nothing matched; `say` explains (shown in the bubble). */
  | { kind: "none"; say: string };

/* ── DOM fallback ─────────────────────────────────────────────────────────── */

export interface DomControl {
  /** Frontend-local id (index into its own element list). */
  id: string;
  /** Visible text, aria-label or title. */
  label: string;
  /** "button", "link", "input", "tab" ... */
  role: string;
  /** Nearby context, e.g. the heading of the section the control is in. */
  context?: string;
  destructiveLooking: boolean;
}

export interface DomPickRequest {
  utterance: string;
  controls: DomControl[];
  settings: RouterSettings;
}

export interface DomPickResult {
  /** Picked control id, or null when none fits well enough. */
  controlId: string | null;
  confidence: number;
}

/* ── Dictation ────────────────────────────────────────────────────────────── */

export interface DictationFormat {
  /** How inner thoughts are marked: `*like this*` or left plain. */
  thought: "asterisks" | "plain";
  /** Dialogue quote marks. */
  quotes: "straight" | "curly";
  /** OOC wrapper. */
  ooc: "double_parens" | "brackets";
}

export interface DictateRequest {
  /** Raw transcript (as STT returned it). */
  text: string;
  format: DictationFormat;
  settings: RouterSettings;
}

export type DictationLabel = "narration" | "dialogue" | "thought" | "ooc";

export interface DictateResult {
  /** Formatted text ready for the composer. Same words as the input. */
  text: string;
  units: Array<{ text: string; label: DictationLabel; paragraphStart: boolean }>;
  /** How sentence ends were found: STT punctuation, an LLM punctuation pass, or Jev gap questions. */
  punctuation: "stt" | "llm" | "jev_gaps";
}

export interface RewriteRequest {
  draft: string;
  chatId: string | null;
  settings: RouterSettings;
}

export interface RewriteResult {
  text: string;
}

/* ── Settings pickers ─────────────────────────────────────────────────────── */

export interface ProfileOption {
  id: string;
  name: string;
  isDefault: boolean;
  model?: string;
}

export interface BackendProfiles {
  decision: ProfileOption[];
  /** null when the host has no embeddings API (embeddings-v1). */
  embedding: ProfileOption[] | null;
}

/* ── Backend fallbacks for missing host actions ───────────────────────────── */

export interface SwipeRequest {
  chatId: string;
  direction: "left" | "right";
}

/* ── RPC envelope ─────────────────────────────────────────────────────────── */

export interface BackendMethods {
  route: (params: RouteRequest) => RouteResult;
  domPick: (params: DomPickRequest) => DomPickResult;
  dictate: (params: DictateRequest) => DictateResult;
  rewrite: (params: RewriteRequest) => RewriteResult;
  listProfiles: (params: Record<string, never>) => BackendProfiles;
  /** Swipe via spindle.chat.updateMessage when the host has no swipe command. "right" past the last swipe fails. */
  swipe: (params: SwipeRequest) => { ok: boolean; say?: string };
  /** Character and persona names, used as STT keywords so Whistle spells them right. */
  listNames: (params: Record<string, never>) => string[];
  /** Settings tabs from spindle.ui.getSettingsTabs, for hosts whose surface catalog lists none (staging before #475). */
  settingsTabs: (params: Record<string, never>) => Array<{ id: string; label: string; description: string; keywords: string[] }>;
  /** spindle.ui.openSettings(id). */
  openSettings: (params: { id: string }) => { ok: true };
  /** spindle.personas.switchActive when the host has no switch_persona action. */
  switchPersona: (params: { personaId: string }) => { ok: true };
}

export type BackendMethod = keyof BackendMethods;

export interface RpcRequest<M extends BackendMethod = BackendMethod> {
  type: "lumi_voice:req";
  id: string;
  method: M;
  params: Parameters<BackendMethods[M]>[0];
}

export type RpcResponse<M extends BackendMethod = BackendMethod> =
  | { type: "lumi_voice:res"; id: string; ok: true; result: ReturnType<BackendMethods[M]> }
  | { type: "lumi_voice:res"; id: string; ok: false; error: { code: string; message: string } };
