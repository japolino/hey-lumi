/**
 * Hey Lumi! backend: answers frontend RPC requests (router, dictation, rewrite, profile lists, fallbacks).
 */
import { createEntityLists } from "./backend/entities";
import { createHandlers, handleRpc, isRpcRequest } from "./backend/handlers";
import type { BackendHost } from "./shared/host-ext";

declare const spindle: BackendHost;

const entities = createEntityLists(spindle);
const handlers = createHandlers(spindle, entities);

spindle.onFrontendMessage(async (payload, userId, frontendSessionId) => {
  if (!isRpcRequest(payload)) return;
  const response = await handleRpc(handlers, payload, userId);
  if (!response.ok) spindle.log.warn(`[hey_lumi] ${payload.method} failed: ${response.error.message}`);
  spindle.sendToFrontend(response, userId, frontendSessionId ? { frontendSessionId } : undefined);
});

for (const event of ["CHARACTER_CREATED", "CHARACTER_EDITED", "CHARACTER_DELETED", "CHARACTER_LIBRARY_CHANGED", "PERSONA_CHANGED", "PRESET_CHANGED", "PRESET_DELETED"]) {
  try {
    spindle.on(event as "CHAT_CHANGED", () => entities.clear());
  } catch {
    // Unknown event names or missing permissions only cost cache freshness.
  }
}
