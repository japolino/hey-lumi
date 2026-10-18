import type { FrontendCtx, HostSurfaceInfo } from "../shared/host-ext";
import type { PlanStep } from "../shared/protocol";
import { findSurface, parseSurfaceActionId } from "./candidates";
import { findComposerButton } from "./draft";
import type { Rpc } from "./rpc";

export interface StepOutcome {
  ok: boolean;
  /** Extra text for the bubble (always set on failure). */
  say?: string;
}

/** Actions on the draft and the screen live in the session (they need its state). */
export interface SessionActions {
  close(): Promise<StepOutcome>;
  stopListening(): Promise<StepOutcome>;
  draftSend(): Promise<StepOutcome>;
  draftRewrite(): Promise<StepOutcome>;
  draftClear(): Promise<StepOutcome>;
  draftRead(): Promise<StepOutcome>;
  undo(): Promise<StepOutcome>;
  screenControl(): Promise<StepOutcome>;
}

export interface ActionEnv {
  ctx: FrontendCtx;
  rpc: Rpc;
  surfaces(): HostSurfaceInfo[];
  generating(): boolean;
  session: SessionActions;
}

const NEEDS_UPDATE = "needs a newer Lumiverse";

function chatId(ctx: FrontendCtx): string | null {
  return ctx.getActiveChat().chatId;
}

async function invoke(env: ActionEnv, kind: string, id: string, params?: Record<string, string>): Promise<StepOutcome> {
  const api = env.ctx.host.surfaces;
  if (!api) return { ok: false, say: `Host navigation ${NEEDS_UPDATE} (ctx.host.surfaces).` };
  await api.invoke({ kind, id }, params);
  return { ok: true };
}

function has(env: ActionEnv, kind: string, id: string): boolean {
  return !!findSurface(env.surfaces(), kind, id);
}

function needArg(step: PlanStep, kind: keyof PlanStep["args"]): string {
  const value = step.args[kind];
  if (!value) throw new Error(`MISSING_ARG: no ${kind.replace("_", " ")} was picked.`);
  return value;
}

async function latestChat(env: ActionEnv, characterId: string): Promise<StepOutcome> {
  const list = (env.ctx.chats as { listForCharacter?: (id: string) => Promise<Array<{ id: string; updated_at?: number }>> }).listForCharacter;
  if (!list) return { ok: false, say: `Opening a character's chats ${NEEDS_UPDATE}.` };
  const chats = await list(characterId);
  const newest = [...chats].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  if (!newest) {
    await invoke(env, "route", "/characters/:id", { id: characterId });
    return { ok: false, say: `There is no chat with this character yet; I opened the character page. Starting a chat by voice ${NEEDS_UPDATE}.` };
  }
  return invoke(env, "route", "/chat/:chatId", { chatId: newest.id });
}

/** Scope hints are not enforced by the host (surface-audit.md 2): check them here. */
function scopeProblem(env: ActionEnv, surface: HostSurfaceInfo | undefined): string | null {
  if (!surface?.scope) return null;
  const open = !!chatId(env.ctx);
  if ((surface.scope === "chat" || surface.scope === "chat-idle") && !open) return `"${surface.label}" needs an open chat.`;
  if (surface.scope === "chat-idle" && env.generating()) return `"${surface.label}" has to wait until the reply is finished.`;
  if (surface.scope === "character" && !env.ctx.getActiveChat().characterId) return `"${surface.label}" needs a character chat.`;
  return null;
}

export async function runStep(step: PlanStep, env: ActionEnv): Promise<StepOutcome> {
  const surfaceRef = parseSurfaceActionId(step.actionId);
  if (surfaceRef) {
    const surface = findSurface(env.surfaces(), surfaceRef.kind, surfaceRef.id);
    if (!surface && surfaceRef.kind === "settings_tab") {
      // Hosts before Lumiverse #475 list no settings tabs; the backend can still open them.
      await env.rpc("openSettings", { id: surfaceRef.id });
      return { ok: true };
    }
    if (!surface) return { ok: false, say: "That is not available right now." };
    const problem = scopeProblem(env, surface);
    if (problem) return { ok: false, say: problem };
    return invoke(env, surfaceRef.kind, surfaceRef.id);
  }

  const { ctx } = env;
  switch (step.actionId) {
    case "lumi:character_open":
      return invoke(env, "route", "/characters/:id", { id: needArg(step, "character") });
    case "lumi:character_chat_latest": {
      const id = needArg(step, "character");
      if (has(env, "entity_action", "character_chat")) return invoke(env, "entity_action", "character_chat", { characterId: id, mode: "latest" });
      return latestChat(env, id);
    }
    case "lumi:character_chat_new": {
      const id = needArg(step, "character");
      if (has(env, "entity_action", "character_chat")) return invoke(env, "entity_action", "character_chat", { characterId: id, mode: "new" });
      await invoke(env, "route", "/characters/:id", { id });
      return { ok: false, say: `Starting a new chat by voice ${NEEDS_UPDATE}; I opened the character page, start it from there.` };
    }
    case "lumi:chat_open":
      return invoke(env, "route", "/chat/:chatId", { chatId: needArg(step, "chat") });
    case "lumi:persona_switch": {
      const id = needArg(step, "persona");
      if (has(env, "entity_action", "switch_persona")) return invoke(env, "entity_action", "switch_persona", { personaId: id });
      await env.rpc("switchPersona", { personaId: id });
      return { ok: true };
    }
    case "lumi:preset_switch":
      if (!has(env, "entity_action", "switch_preset")) return { ok: false, say: `Switching presets by voice ${NEEDS_UPDATE}.` };
      return invoke(env, "entity_action", "switch_preset", { presetId: needArg(step, "preset") });
    case "lumi:theme_apply":
      if (!has(env, "entity_action", "apply_theme")) return { ok: false, say: `Applying themes by voice ${NEEDS_UPDATE}.` };
      return invoke(env, "entity_action", "apply_theme", { themeId: needArg(step, "theme") });
    case "lumi:llm_switch": {
      const id = needArg(step, "llm_profile");
      const c = ctx.connections;
      if (!c?.setActiveAcknowledged && !c?.setActive) return { ok: false, say: `Switching connection profiles ${NEEDS_UPDATE}.` };
      await (c.setActiveAcknowledged ? c.setActiveAcknowledged(id) : c.setActive!(id));
      return { ok: true };
    }
    case "lumi:swipe_left":
    case "lumi:swipe_right": {
      const direction = step.actionId === "lumi:swipe_left" ? "left" : "right";
      const command = `action-swipe-${direction}`;
      if (has(env, "command", command)) return invoke(env, "command", command);
      const chat = chatId(ctx);
      if (!chat) return { ok: false, say: "Swiping needs an open chat." };
      const res = await env.rpc("swipe", { chatId: chat, direction });
      if (!res.ok && direction === "right" && has(env, "command", "action-regenerate") && !env.generating()) {
        await invoke(env, "command", "action-regenerate");
        return { ok: true, say: "That was the last swipe, so I asked for a new one." };
      }
      return res.ok ? { ok: true } : { ok: false, say: res.say ?? "Could not swipe." };
    }
    case "lumi:stop": {
      // "Stop" while nothing streams means the user is done with Lumi.
      if (!env.generating()) return env.session.close();
      if (has(env, "command", "action-stop-generation")) return invoke(env, "command", "action-stop-generation");
      const button = findComposerButton();
      if (!button) return { ok: false, say: "I could not find the stop button." };
      button.click();
      return { ok: true };
    }
    case "lumi:close":
      return env.session.close();
    case "lumi:stop_listening":
      return env.session.stopListening();
    case "lumi:draft_send":
      return env.session.draftSend();
    case "lumi:draft_rewrite":
      return env.session.draftRewrite();
    case "lumi:draft_clear":
      return env.session.draftClear();
    case "lumi:draft_read":
      return env.session.draftRead();
    case "lumi:undo":
      return env.session.undo();
    case "lumi:screen_control":
      return env.session.screenControl();
  }
  return { ok: false, say: `I do not know how to do "${step.actionId}".` };
}
