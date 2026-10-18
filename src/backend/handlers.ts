import type { BackendHost } from "../shared/host-ext";
import type { ArgKind, BackendMethod, BackendMethods, RouteRequest, RpcRequest, RpcResponse } from "../shared/protocol";
import { formatDictation, rewriteDraft } from "./dictation/index";
import type { EntityLists } from "./entities";
import { pickDomControl, routeUtterance } from "./router/index";
import { createServices } from "./services/index";
import type { ChatMessage, Services } from "./services/types";

type Handlers = { [M in BackendMethod]: (params: Parameters<BackendMethods[M]>[0]) => Promise<ReturnType<BackendMethods[M]>> };

const BACKEND_KINDS = ["character", "persona", "preset"] as const;
const REWRITE_CONTEXT_MESSAGES = 8;

export function createHandlers(host: BackendHost, entities: EntityLists, services: (settings: RouteRequest["settings"]) => Services = (s) => createServices(host, s)): Handlers {
  return {
    async route(req) {
      const needed = new Set(req.candidates.map((c) => c.arg).filter((a): a is ArgKind => !!a));
      const filled = { ...req.entities };
      for (const kind of BACKEND_KINDS) {
        if (!needed.has(kind)) continue;
        const items = await entities.get(kind);
        if (items) filled[kind] = items;
      }
      return routeUtterance({ ...req, entities: filled }, services(req.settings));
    },
    domPick: (req) => pickDomControl(req, services(req.settings)),
    dictate: (req) => formatDictation(req, services(req.settings)),
    async rewrite(req) {
      let recent: ChatMessage[] = [];
      if (req.chatId) {
        const messages = await host.chat.getMessages(req.chatId);
        recent = messages.slice(-REWRITE_CONTEXT_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
      }
      return { text: await rewriteDraft(req.draft, recent, services(req.settings)) };
    },
    async listProfiles() {
      const decision = host.permissions.has("decisions")
        ? (await host.decisions.listConnections()).map((c) => ({ id: c.id, name: c.name, isDefault: c.is_default }))
        : [];
      const embedding = host.embeddings
        ? (await host.embeddings.listConnections()).filter((c) => c.enabled).map((c) => ({ id: c.id, name: c.name, isDefault: c.is_primary }))
        : null;
      return { decision, embedding };
    },
    async swipe({ chatId, direction }) {
      const messages = await host.chat.getMessages(chatId);
      const last = messages.findLast((m) => !m.is_user);
      if (!last) return { ok: false, say: "There is no reply to swipe." };
      const next = last.swipe_id + (direction === "left" ? -1 : 1);
      if (next < 0) return { ok: false, say: "This is already the first swipe." };
      if (next >= last.swipes.length) return { ok: false, say: "This is the last swipe. Say \"regenerate\" for a new one." };
      await host.chat.updateMessage(chatId, last.id, { swipe_id: next });
      return { ok: true };
    },
    async switchPersona({ personaId }) {
      await host.personas.switchActive(personaId);
      return { ok: true };
    },
  };
}

export function isRpcRequest(payload: unknown): payload is RpcRequest {
  const p = payload as RpcRequest | null;
  return !!p && p.type === "lumi_voice:req" && typeof p.id === "string" && typeof p.method === "string";
}

/** "CODE: message" errors keep their code; anything else is LUMI_VOICE_ERROR. */
export function errorResponse(id: string, error: unknown): RpcResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^([A-Z][A-Z0-9_]+)(?::|$)/.exec(message)?.[1] ?? "LUMI_VOICE_ERROR";
  return { type: "lumi_voice:res", id, ok: false, error: { code, message } };
}

export async function handleRpc(handlers: Handlers, req: RpcRequest): Promise<RpcResponse> {
  const handler = handlers[req.method] as ((params: unknown) => Promise<unknown>) | undefined;
  if (!handler) return errorResponse(req.id, new Error(`UNKNOWN_METHOD: ${req.method}`));
  try {
    return { type: "lumi_voice:res", id: req.id, ok: true, result: (await handler(req.params)) as never };
  } catch (error) {
    return errorResponse(req.id, error);
  }
}
