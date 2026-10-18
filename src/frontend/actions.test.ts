import { expect, test } from "bun:test";
import type { FrontendCtx, HostSurfaceInfo } from "../shared/host-ext";
import type { PlanStep } from "../shared/protocol";
import { runStep, type ActionEnv } from "./actions";

function env(surfaces: HostSurfaceInfo[], extra: { chats?: object; connections?: object; rpc?: (m: string, p: unknown) => unknown; chatId?: string | null; generating?: boolean } = {}) {
  const invoked: Array<[string, string, Record<string, string> | undefined]> = [];
  const rpcCalls: Array<[string, unknown]> = [];
  const ctx = {
    getActiveChat: () => ({ chatId: extra.chatId === undefined ? "chat1" : extra.chatId, characterId: "char1" }),
    host: { capabilities: {}, surfaces: { list: () => surfaces, subscribe: () => () => {}, invoke: async (ref: { kind: string; id: string }, p?: Record<string, string>) => void invoked.push([ref.kind, ref.id, p]) } },
    chats: extra.chats ?? {},
    ...(extra.connections ? { connections: extra.connections } : {}),
  } as unknown as FrontendCtx;
  const e: ActionEnv = {
    ctx,
    rpc: (async (m: string, p: unknown) => (rpcCalls.push([m, p]), extra.rpc?.(m, p) ?? { ok: true })) as never,
    surfaces: () => surfaces,
    generating: () => !!extra.generating,
    session: {} as ActionEnv["session"],
  };
  return { e, invoked, rpcCalls };
}

const step = (actionId: string, args: PlanStep["args"] = {}): PlanStep => ({ actionId, args });
const routes: HostSurfaceInfo[] = [
  { kind: "route", id: "/characters/:id", label: "Character" },
  { kind: "route", id: "/chat/:chatId", label: "Chat" },
];

test("new chat uses the character_chat entity action when the host has it", async () => {
  const { e, invoked } = env([...routes, { kind: "entity_action", id: "character_chat", label: "Chat with character" }]);
  expect(await runStep(step("lumi:character_chat_new", { character: "c9" }), e)).toEqual({ ok: true });
  expect(invoked).toEqual([["entity_action", "character_chat", { characterId: "c9", mode: "new" }]]);
});

test("without the host action: new chat opens the character page and says what is missing", async () => {
  const { e, invoked } = env(routes);
  const out = await runStep(step("lumi:character_chat_new", { character: "c9" }), e);
  expect(out.ok).toBe(false);
  expect(out.say).toContain("newer Lumiverse");
  expect(invoked).toEqual([["route", "/characters/:id", { id: "c9" }]]);
});

test("latest chat falls back to listForCharacter + the chat route", async () => {
  const chats = { listForCharacter: async () => [{ id: "old", updated_at: 1 }, { id: "new", updated_at: 5 }] };
  const { e, invoked } = env(routes, { chats });
  await runStep(step("lumi:character_chat_latest", { character: "c9" }), e);
  expect(invoked).toEqual([["route", "/chat/:chatId", { chatId: "new" }]]);
});

test("persona switch falls back to the backend; preset and theme report the missing host action", async () => {
  const { e, rpcCalls } = env(routes);
  expect((await runStep(step("lumi:persona_switch", { persona: "p1" }), e)).ok).toBe(true);
  expect(rpcCalls).toEqual([["switchPersona", { personaId: "p1" }]]);
  expect((await runStep(step("lumi:preset_switch", { preset: "x" }), e)).say).toContain("newer Lumiverse");
  expect((await runStep(step("lumi:theme_apply", { theme: "x" }), e)).say).toContain("newer Lumiverse");
});

test("swipe right past the last swipe regenerates; with the host command it just invokes it", async () => {
  const regen: HostSurfaceInfo = { kind: "command", id: "action-regenerate", label: "Regenerate", scope: "chat-idle" };
  const { e, invoked } = env([regen], { rpc: () => ({ ok: false, say: "last" }) });
  const out = await runStep(step("lumi:swipe_right"), e);
  expect(out.ok).toBe(true);
  expect(invoked).toEqual([["command", "action-regenerate", undefined]]);

  const withCmd = env([{ kind: "command", id: "action-swipe-right", label: "Next Swipe" }]);
  await runStep(step("lumi:swipe_right"), withCmd.e);
  expect(withCmd.invoked).toEqual([["command", "action-swipe-right", undefined]]);
  expect(withCmd.rpcCalls).toEqual([]);
});

test("surface scope is checked before invoking", async () => {
  const cont: HostSurfaceInfo = { kind: "command", id: "action-continue", label: "Continue Generation", scope: "chat-idle" };
  const { e, invoked } = env([cont], { generating: true });
  const out = await runStep(step("surface:command:action-continue"), e);
  expect(out.ok).toBe(false);
  expect(invoked).toEqual([]);
  const noChat = env([cont], { chatId: null });
  expect((await runStep(step("surface:command:action-continue"), noChat.e)).say).toContain("open chat");
});

test("LLM profile switch prefers setActiveAcknowledged; a missing arg fails clearly", async () => {
  const calls: string[] = [];
  const { e } = env([], { connections: { list: () => [], setActiveAcknowledged: async (id: string) => void calls.push(id) } });
  await runStep(step("lumi:llm_switch", { llm_profile: "p2" }), e);
  expect(calls).toEqual(["p2"]);
  await expect(runStep(step("lumi:llm_switch"), e)).rejects.toThrow("MISSING_ARG");
});
