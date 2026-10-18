import { expect, test } from "bun:test";
import type { FrontendCtx, HostSurfaceInfo } from "../shared/host-ext";
import type { BackendMethod, RouteRequest, RouteResult } from "../shared/protocol";
import { DEFAULT_SETTINGS } from "../shared/settings";
import type { AudioSource, SpeechBurst, WakeDetector } from "./audio/types";
import type { Draft } from "./draft";
import { createSession, type SessionView } from "./session";

function harness(routes: RouteResult[], opts: { idleSec?: number } = {}) {
  const invoked: Array<{ kind: string; id: string; params?: Record<string, string> }> = [];
  const routeCalls: RouteRequest[] = [];
  const views: SessionView[] = [];
  let draftText = "";
  let wakeStarts = 0;
  let onWake: ((hit: { rest: string }) => void) | null = null;
  const burstListeners: Array<(b: SpeechBurst) => void> = [];
  const surfaces: HostSurfaceInfo[] = [
    { kind: "drawer_tab", id: "theme", label: "Theme" },
    { kind: "command", id: "action-delete-chat", label: "Delete Chat", scope: "chat" },
  ];
  const ctx = {
    getActiveChat: () => ({ chatId: "chat1", characterId: "char1" }),
    host: { capabilities: {}, surfaces: { list: () => surfaces, subscribe: () => () => {}, invoke: async (ref: { kind: string; id: string }, params?: Record<string, string>) => void invoked.push({ ...ref, params }) } },
    chats: {},
  } as unknown as FrontendCtx;
  const source: AudioSource = {
    onFrames: () => () => {},
    onBurst: (l) => (burstListeners.push(l), () => {}),
    onSpeechStart: () => () => {},
  };
  const wake: WakeDetector = {
    async start(_s, cb) {
      wakeStarts++;
      onWake = cb;
    },
    stop() {
      onWake = null;
    },
  };
  const draft: Draft = { via: "dom", available: () => true, get: () => draftText, set: (t) => void (draftText = t), focus() {}, async send() {} };
  const rpc = (async (method: BackendMethod, params: any) => {
    if (method === "route") {
      routeCalls.push(params);
      return routes.shift() ?? { kind: "ignore" };
    }
    if (method === "dictate") return { text: `<${params.text}>`, units: [], punctuation: "stt" };
    throw new Error(`unexpected ${method}`);
  }) as never;
  const session = createSession({
    ctx,
    rpc,
    draft,
    source,
    transcriber: { transcribe: async (b) => ({ text: (b as unknown as { text: string }).text }) },
    wake: () => wake,
    matchWake: (t) => (/^hey lumi\b[\s,.!]*/i.test(t) ? { rest: t.replace(/^hey lumi\b[\s,.!]*/i, "") } : null),
    settings: () => ({ ...DEFAULT_SETTINGS, idleTimeoutSec: opts.idleSec ?? 20 }),
    surfaces: () => surfaces,
    candidates: () => [],
    entities: async () => ({}),
    generating: () => false,
    bubbleElement: () => null,
    render: (v) => void views.push(v),
  });
  const say = async (text: string) => {
    for (const l of burstListeners) l({ text } as unknown as SpeechBurst);
    await Bun.sleep(5);
  };
  return {
    session,
    invoked,
    routeCalls,
    last: () => views.at(-1)!,
    wakeHit: async (rest: string) => {
      onWake?.({ rest });
      await Bun.sleep(5);
    },
    say,
    draft: () => draftText,
    wakeStarts: () => wakeStarts,
  };
}

const run = (actionId: string, say: string, confirm = false): RouteResult => ({ kind: "run", steps: [{ actionId, args: {} }], say, confirm, confidence: 0.9 });

test("wake word with a command opens the session, routes and runs the surface", async () => {
  const h = harness([run("surface:drawer_tab:theme", "Opening Theme")]);
  await h.session.startWake();
  await h.wakeHit("open my themes");
  expect(h.routeCalls[0]!.utterance).toBe("open my themes");
  expect(h.invoked).toEqual([{ kind: "drawer_tab", id: "theme", params: undefined }]);
  expect(h.last().phase).toBe("listening");
  expect(h.last().said).toBe("Opening Theme");
});

test("close intent and a repeated wake word both close and re-arm the wake word", async () => {
  const h = harness([{ kind: "close" }]);
  await h.session.startWake();
  await h.wakeHit("");
  await h.say("that's about it");
  expect(h.last().phase).toBe("closed");
  expect(h.wakeStarts()).toBe(2);
  await h.wakeHit("");
  await h.say("hey lumi");
  expect(h.last().phase).toBe("closed");
  expect(h.routeCalls.length).toBe(1);
});

test("destructive steps wait for a spoken yes", async () => {
  const h = harness([run("surface:command:action-delete-chat", "Deleting this chat", true)]);
  h.session.open();
  await h.say("delete this chat");
  expect(h.last().phase).toBe("confirming");
  expect(h.invoked).toEqual([]);
  await h.say("yes");
  expect(h.invoked.map((i) => i.id)).toEqual(["action-delete-chat"]);
});

test("an ask sends the next utterance with the pending question; clicking an option runs its step", async () => {
  const pending = { question: "Did you mean Theme?", options: [{ label: "Theme", step: { actionId: "surface:drawer_tab:theme", args: {} } }] };
  const h = harness([{ kind: "ask", pending }, { kind: "ignore" }]);
  h.session.open();
  await h.say("open the thing");
  expect(h.last().phase).toBe("asking");
  await h.say("the first one");
  expect(h.routeCalls[1]!.pending).toEqual(pending);
  expect(h.routeCalls[1]!.context.history.at(-1)?.did).toContain("asked");

  const h2 = harness([{ kind: "ask", pending }]);
  h2.session.open();
  await h2.say("open the thing");
  h2.last().options[0]!.pick();
  await Bun.sleep(5);
  expect(h2.invoked.map((i) => i.id)).toEqual(["theme"]);
});

test("dictation appends to the draft and undo restores it", async () => {
  const h = harness([{ kind: "dictation", text: "she smiles" }, { kind: "dictation", text: "and waves" }, run("lumi:undo", "Undo")]);
  h.session.open();
  await h.say("she smiles");
  await h.say("and waves");
  expect(h.draft()).toBe("<she smiles> <and waves>");
  await h.say("undo that");
  expect(h.draft()).toBe("<she smiles>");
});

test("the session closes after the idle timeout", async () => {
  const h = harness([], { idleSec: 0.02 });
  h.session.open();
  await Bun.sleep(60);
  expect(h.last().phase).toBe("closed");
});
