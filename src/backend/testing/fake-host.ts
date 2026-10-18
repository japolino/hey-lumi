/**
 * Small in-memory fake of the Spindle backend API for handler tests. Mirrors the real object's shape where used,
 * including spindle.host (descriptor with capabilities) and spindle.log.
 */
import type { BackendHost } from "../../shared/host-ext";

export interface FakeMessage {
  id: string;
  is_user: boolean;
  content: string;
  swipe_id: number;
  swipes: string[];
}

export function createFakeHost(options: { capabilities?: Record<string, number>; granted?: string[] } = {}) {
  const granted = new Set(options.granted ?? ["characters", "personas", "presets", "decisions", "chat_mutation", "chats"]);
  const state = {
    characters: [] as Array<{ id: string; name: string; tags: string[]; image_id: string | null }>,
    personas: [] as Array<{ id: string; name: string; title: string; image_id: string | null }>,
    presets: [] as Array<{ id: string; name: string }>,
    messages: new Map<string, FakeMessage[]>(),
    updates: [] as Array<{ chatId: string; messageId: string; patch: Record<string, unknown> }>,
    activePersona: null as string | null,
    characterPages: 0,
    logs: [] as string[],
    opened: [] as string[],
  };
  const host = {
    host: { descriptorVersion: 1, lumiverseVersion: "test", capabilities: { "decisions-v1": 1, ...options.capabilities }, extensionInstallationId: "test" },
    log: { info: (m: string) => void state.logs.push(m), warn: (m: string) => void state.logs.push(m), error: (m: string) => void state.logs.push(m) },
    permissions: { has: (p: string) => granted.has(p), getGranted: async () => [...granted] },
    characters: {
      async list({ limit = 50, offset = 0 } = {}) {
        state.characterPages++;
        return { data: state.characters.slice(offset, offset + limit), total: state.characters.length };
      },
    },
    personas: {
      list: async () => ({ data: state.personas, total: state.personas.length }),
      switchActive: async (id: string | null) => void (state.activePersona = id),
    },
    presets: { list: async () => ({ data: state.presets, total: state.presets.length }) },
    ui: {
      getSettingsTabs: async () => [{ id: "voice", shortName: "Voice", tabName: "Voice & Speech", tabDescription: "TTS and STT", keywords: ["tts"] }],
      openSettings: async (id: string) => void state.opened.push(id),
    },
    decisions: { listConnections: async () => [{ id: "d1", name: "Jev", is_default: true }] },
    chat: {
      getMessages: async (chatId: string) => (state.messages.get(chatId) ?? []).map((m) => ({ ...m, role: m.is_user ? "user" : "assistant" })),
      async updateMessage(chatId: string, messageId: string, patch: Record<string, unknown>) {
        state.updates.push({ chatId, messageId, patch });
      },
    },
  };
  return { host: host as unknown as BackendHost, state, granted };
}
