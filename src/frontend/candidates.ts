import type { FrontendCtx, HostSurfaceInfo } from "../shared/host-ext";
import { LUMI_ACTIONS, type ActionCandidate, type ArgKind, type EntityOption } from "../shared/protocol";

/** Host commands that Lumi wraps in its own action (so the fallback runs on hosts without them). */
const WRAPPED_COMMANDS: Record<string, string> = {
  "action-stop-generation": "lumi:stop",
  "action-swipe-left": "lumi:swipe_left",
  "action-swipe-right": "lumi:swipe_right",
};
/** Opens a file picker; browsers block that without a click. */
const SKIPPED_COMMANDS = new Set(["action-import-character"]);
const DESTRUCTIVE_COMMANDS = new Set(["action-delete-last-message", "action-delete-chat"]);
const KIND_TEXT: Record<string, string> = {
  drawer_tab: "Side panel",
  settings_tab: "Settings page",
  command: "Command",
  route: "Page",
  input_bar_action: "Chat input action",
  ext_command: "Extension command",
};

export function surfaceActionId(kind: string, id: string): string {
  return `surface:${kind}:${id}`;
}

export function parseSurfaceActionId(actionId: string): { kind: string; id: string } | null {
  const m = /^surface:([a-z_]+):(.+)$/.exec(actionId);
  return m ? { kind: m[1]!, id: m[2]! } : null;
}

/**
 * Router candidates: invocable host surfaces without params (minus duplicates) plus Lumi's own actions.
 * `fallbackSettings` (from the backend's spindle.ui.getSettingsTabs) fills in settings tabs when the catalog has none.
 * `ownOwner` is Hey Lumi!'s own owner id in the catalog; its surfaces are left out.
 */
export function buildCandidates(surfaces: HostSurfaceInfo[], fallbackSettings: HostSurfaceInfo[] = [], ownOwner?: string): ActionCandidate[] {
  if (!surfaces.some((s) => s.kind === "settings_tab")) surfaces = [...surfaces, ...fallbackSettings];
  // Lumi's own drawer tab and input-bar action are not voice targets ("stop listening" / "close" are Lumi actions).
  if (ownOwner) surfaces = surfaces.filter((s) => s.owner !== ownOwner);
  const drawerIds = new Set(surfaces.filter((s) => s.kind === "drawer_tab").map((s) => s.id));
  const settingsIds = new Set(surfaces.filter((s) => s.kind === "settings_tab").map((s) => s.id));
  const out: ActionCandidate[] = [];
  for (const s of surfaces) {
    if (s.invocable === false || !(s.kind in KIND_TEXT)) continue;
    if (s.kind === "route" && s.id.includes(":")) continue;
    if (s.kind === "command") {
      if (WRAPPED_COMMANDS[s.id] || SKIPPED_COMMANDS.has(s.id)) continue;
      if (s.id.startsWith("panel-") && drawerIds.has(s.id.slice(6))) continue;
      if (s.id.startsWith("settings-") && settingsIds.has(s.id.slice(9))) continue;
    }
    out.push({
      id: surfaceActionId(s.kind, s.id),
      label: s.label,
      description: [KIND_TEXT[s.kind], s.description].filter(Boolean).join(": "),
      ...(s.keywords?.length ? { keywords: s.keywords } : {}),
      ...(s.kind === "command" && DESTRUCTIVE_COMMANDS.has(s.id) ? { destructive: true } : {}),
    });
  }
  for (const [id, a] of Object.entries(LUMI_ACTIONS)) {
    out.push({ id, label: a.label, description: a.description, ...("arg" in a ? { arg: a.arg } : {}), ...("destructive" in a ? { destructive: true } : {}) });
  }
  return out;
}

export function findSurface(surfaces: HostSurfaceInfo[], kind: string, id: string): HostSurfaceInfo | undefined {
  return surfaces.find((s) => s.kind === kind && s.id === id);
}

/** Theme ids from the apply_theme entity action (parameterized host actions); empty on hosts without it. */
export function themeOptions(surfaces: HostSurfaceInfo[]): EntityOption[] {
  const oneOf = findSurface(surfaces, "entity_action", "apply_theme")?.params?.properties.themeId?.oneOf ?? [];
  return oneOf.map((o) => ({ id: o.const, name: o.title }));
}

export async function llmProfileOptions(ctx: FrontendCtx): Promise<EntityOption[]> {
  if (!ctx.connections) return [];
  const rows = (await Promise.resolve(ctx.connections.list())) as Array<{ id: string; name: string; provider?: string; model?: string }>;
  return (Array.isArray(rows) ? rows : []).map((p) => ({ id: p.id, name: p.name, detail: [p.provider, p.model].filter(Boolean).join(" ") || undefined }));
}

async function recentChats(ctx: FrontendCtx) {
  if (!ctx.chats.listRecent) return [];
  return (await ctx.chats.listRecent({ limit: 30, sort: "recent", direction: "desc" })).data;
}

export function recentChatOptions(rows: Awaited<ReturnType<typeof recentChats>>): EntityOption[] {
  return rows.map((c) => ({
    id: c.id,
    name: c.name || c.character_name,
    detail: [c.character_name, c.last_message_preview?.slice(0, 80)].filter(Boolean).join(": "),
    ...(c.character_image_id ? { imageId: c.character_image_id } : {}),
  }));
}

export interface FrontendEntities {
  lists: Partial<Record<ArgKind, EntityOption[]>>;
  /** Characters of the recent chats, newest first, without repeats. */
  recentCharacterIds: string[];
}

/** Frontend-owned entity lists for the router. Cached briefly: one utterance should not cost three REST calls. */
export function createFrontendEntities(ctx: FrontendCtx, surfaces: () => HostSurfaceInfo[]) {
  let cached: { at: number; value: FrontendEntities } | null = null;
  return {
    async get(): Promise<FrontendEntities> {
      if (cached && Date.now() - cached.at < 20_000) return cached.value;
      const [llm, chats] = await Promise.all([llmProfileOptions(ctx).catch(() => []), recentChats(ctx).catch(() => [])]);
      const value = {
        lists: { theme: themeOptions(surfaces()), llm_profile: llm, chat: recentChatOptions(chats) },
        recentCharacterIds: [...new Set(chats.map((c) => c.character_id).filter(Boolean))],
      };
      cached = { at: Date.now(), value };
      return value;
    },
    invalidate() {
      cached = null;
    },
  };
}
