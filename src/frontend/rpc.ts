import type { BackendMethod, BackendMethods, RpcRequest, RpcResponse } from "../shared/protocol";
import type { FrontendCtx } from "../shared/host-ext";

const TIMEOUT_MS = 45_000;

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type Rpc = <M extends BackendMethod>(method: M, params: Parameters<BackendMethods[M]>[0]) => Promise<ReturnType<BackendMethods[M]>>;

/** Request/response over ctx.sendToBackend. One timeout so a restarting backend cannot leave the bubble waiting forever. */
export function createRpc(ctx: Pick<FrontendCtx, "sendToBackend" | "onBackendMessage">): { call: Rpc; dispose(): void } {
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 0;
  const off = ctx.onBackendMessage((payload) => {
    const res = payload as RpcResponse | null;
    if (!res || res.type !== "hey_lumi:res") return;
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    clearTimeout(entry.timer);
    if (res.ok) entry.resolve(res.result);
    else entry.reject(new RpcError(res.error.code, res.error.message));
  });
  const call: Rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = `${Date.now().toString(36)}-${++next}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcError("TIMEOUT", `Hey Lumi! backend did not answer (${method}).`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      const req: RpcRequest = { type: "hey_lumi:req", id, method, params } as RpcRequest;
      ctx.sendToBackend(req);
    });
  return {
    call,
    dispose() {
      off();
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new RpcError("DISPOSED", "Hey Lumi! stopped."));
      }
      pending.clear();
    },
  };
}
