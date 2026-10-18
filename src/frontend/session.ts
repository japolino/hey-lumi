import type { FrontendCtx, HostSurfaceInfo } from "../shared/host-ext";
import type { ActionCandidate, PendingAsk, PlanStep, RouteContext, RouteResult } from "../shared/protocol";
import type { FrontendEntities } from "./candidates";
import { routerSettings, type LumiVoiceSettings } from "../shared/settings";
import { runStep, type SessionActions, type StepOutcome } from "./actions";
import type { AudioSource, Transcriber, WakeDetector } from "./audio/types";
import { activateControl, collectControls } from "./dom-fallback";
import { appendDictation, type Draft } from "./draft";
import type { Rpc } from "./rpc";

export type SessionPhase = "closed" | "listening" | "thinking" | "asking" | "confirming";

export interface SessionOption {
  label: string;
  pick(): void;
}

/** Everything the bubble shows. */
export interface SessionView {
  phase: SessionPhase;
  /** Last thing the user said. */
  heard: string;
  /** Lumi's last message (what it did, a question, an error). */
  said: string;
  /** Clickable answers for "asking" / "confirming". */
  options: SessionOption[];
  /** The user is speaking right now. */
  hearing: boolean;
}

export interface SessionDeps {
  ctx: FrontendCtx;
  rpc: Rpc;
  draft: Draft;
  source: AudioSource;
  transcriber: Transcriber;
  /** null when the wake word is off: the session opens only by click. */
  wake: () => WakeDetector | null;
  matchWake(text: string): { rest: string } | null;
  settings(): LumiVoiceSettings;
  surfaces(): HostSurfaceInfo[];
  candidates(): ActionCandidate[];
  entities(): Promise<FrontendEntities>;
  /** Turn the mic off (the "stop listening" action). */
  stopListening(): void;
  generating(): boolean;
  /** Speak a short text with host TTS; resolves when done. Undefined without ctx.tts. */
  speak?: (text: string) => Promise<void>;
  /** Lumi's own UI, left out of the DOM fallback. */
  bubbleElement(): Element | null;
  render(view: SessionView): void;
}

const YES = /^\W*(yes|yeah|yep|yup|sure|do it|go ahead|confirm|okay|ok|please do)\b/i;
const NO = /^\W*(no|nope|cancel|don'?t|stop|never ?mind|forget it)\b/i;
const HISTORY = 6;

export function createSession(deps: SessionDeps) {
  let phase: SessionPhase = "closed";
  let heard = "";
  let said = "";
  let options: SessionOption[] = [];
  let hearing = false;
  let pending: PendingAsk | undefined;
  let confirmRun: (() => Promise<void>) | null = null;
  let history: RouteContext["history"] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let queued: string | null = null;
  let currentUtterance = "";
  const undoStack: string[] = [];
  let lastInsert: string | null = null;
  let wakeRunning: WakeDetector | null = null;
  const offs: Array<() => void> = [];

  const render = () => deps.render({ phase, heard, said, options, hearing });
  const set = (patch: { phase?: SessionPhase; heard?: string; said?: string; options?: SessionOption[] }) => {
    if (patch.phase !== undefined) phase = patch.phase;
    if (patch.heard !== undefined) heard = patch.heard;
    if (patch.said !== undefined) said = patch.said;
    if (patch.options !== undefined) options = patch.options;
    render();
  };

  function armIdle() {
    clearTimeout(idleTimer);
    if (phase === "closed") return;
    idleTimer = setTimeout(() => {
      if (!busy) close();
    }, deps.settings().idleTimeoutSec * 1000);
  }

  async function startWake() {
    const detector = deps.wake();
    if (!detector || wakeRunning) return;
    wakeRunning = detector;
    try {
      await detector.start(deps.source, (hit) => open(hit.rest));
    } catch (error) {
      wakeRunning = null;
      set({ said: `Wake word unavailable: ${message(error)}` });
    }
  }

  function stopWake() {
    wakeRunning?.stop();
    wakeRunning = null;
  }

  function open(first = "") {
    if (phase !== "closed") return;
    stopWake();
    history = [];
    pending = undefined;
    confirmRun = null;
    set({ phase: "listening", heard: "", said: "Listening...", options: [] });
    armIdle();
    if (first.trim()) void utterance(first);
  }

  function close() {
    if (phase === "closed") return;
    clearTimeout(idleTimer);
    pending = undefined;
    confirmRun = null;
    queued = null;
    set({ phase: "closed", options: [] });
    void startWake();
  }

  async function say(text: string) {
    set({ said: text });
    if (deps.speak && deps.settings().voiceReplies && text) await deps.speak(text).catch(() => {});
  }

  async function utterance(text: string) {
    if (phase === "closed") return;
    if (busy) {
      queued = queued ? `${queued} ${text}` : text;
      return;
    }
    busy = true;
    clearTimeout(idleTimer);
    try {
      await handle(text);
    } catch (error) {
      set({ phase: "listening", options: [] });
      await say(`Something went wrong: ${message(error)}`);
    } finally {
      busy = false;
      armIdle();
    }
    if (queued !== null && (phase as SessionPhase) !== "closed") {
      const next = queued;
      queued = null;
      await utterance(next);
    }
  }

  async function handle(raw: string) {
    let text = raw.trim();
    const wake = deps.matchWake(text);
    if (wake) {
      if (!wake.rest) return close();
      text = wake.rest;
    }
    if (!text) return;
    currentUtterance = text;
    set({ heard: text });

    if (phase === "confirming" && confirmRun) {
      if (YES.test(text)) return confirmed(true);
      if (NO.test(text)) return confirmed(false);
      confirmRun = null;
    }

    set({ phase: "thinking", options: [] });
    const settings = deps.settings();
    const entities = await deps.entities();
    const result = await deps.rpc("route", {
      utterance: text,
      context: {
        route: globalThis.location?.pathname ?? "/",
        chatOpen: !!deps.ctx.getActiveChat().chatId,
        generating: deps.generating(),
        draft: deps.draft.available() ? deps.draft.get() : "",
        history,
        lumiSaid: said,
        recentCharacterIds: entities.recentCharacterIds,
      },
      candidates: deps.candidates(),
      entities: entities.lists,
      ...(pending ? { pending } : {}),
      settings: routerSettings(settings),
    });
    pending = undefined;
    await apply(result, text);
  }

  function remember(saidText: string, did: string) {
    history = [...history, { said: saidText, did }].slice(-HISTORY);
  }

  async function apply(result: RouteResult, text: string) {
    switch (result.kind) {
      case "close":
        remember(text, "closed");
        return close();
      case "ignore":
        remember(text, "ignored (not for Lumi)");
        set({ phase: "listening" });
        return;
      case "none":
        remember(text, `nothing: ${result.say}`);
        set({ phase: "listening" });
        return say(result.say);
      case "dictation":
        return dictate(result.text, text);
      case "ask":
        pending = result.pending;
        remember(text, `asked: ${result.pending.question}`);
        set({
          phase: "asking",
          options: result.pending.options.map((o) => ({
            label: o.label,
            pick: () => {
              pending = undefined;
              void exclusive(() => runSteps([o.step], o.label));
            },
          })),
        });
        return say(result.pending.question);
      case "run":
        if (result.confirm) {
          confirmRun = () => runSteps(result.steps, result.say);
          remember(text, `asked to confirm: ${result.say}`);
          set({
            phase: "confirming",
            options: [
              { label: "Yes", pick: () => void exclusive(() => confirmed(true)) },
              { label: "No", pick: () => void exclusive(() => confirmed(false)) },
            ],
          });
          return say(`${result.say}. Are you sure?`);
        }
        remember(text, result.say);
        return runSteps(result.steps, result.say);
    }
  }

  /** Clicks run outside the utterance queue; keep them from overlapping with it. */
  async function exclusive(run: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await run();
    } catch (error) {
      set({ phase: "listening", options: [] });
      await say(`Something went wrong: ${message(error)}`);
    } finally {
      busy = false;
      armIdle();
    }
  }

  async function confirmed(yes: boolean) {
    const run = confirmRun;
    confirmRun = null;
    if (!yes || !run) {
      set({ phase: "listening", options: [] });
      return say("Okay, I left it.");
    }
    await run();
  }

  async function runSteps(steps: PlanStep[], summary: string) {
    set({ phase: "thinking", options: [], said: `${summary}...` });
    const notes: string[] = [];
    for (const [i, step] of steps.entries()) {
      let outcome: StepOutcome;
      try {
        outcome = await runStep(step, env);
      } catch (error) {
        outcome = { ok: false, say: message(error) };
      }
      if (outcome.say) notes.push(outcome.say);
      if (!outcome.ok) {
        set({ phase: phase === "confirming" ? "confirming" : "listening" });
        const prefix = steps.length > 1 ? `Step ${i + 1} of ${steps.length} failed. ` : "";
        return say(prefix + notes.join(" "));
      }
      // Let the host render the result before the next step looks at the page.
      if (steps.length > 1) await new Promise((r) => setTimeout(r, 400));
    }
    if (phase === "thinking") set({ phase: "listening" });
    await say(notes.length ? notes.join(" ") : summary);
  }

  async function dictate(text: string, saidText: string) {
    if (!deps.draft.available()) {
      remember(saidText, "dictation failed: no chat input");
      set({ phase: "listening" });
      return say("Open a chat to dictate.");
    }
    const settings = deps.settings();
    const formatted = await deps.rpc("dictate", { text, format: settings.format, settings: routerSettings(settings) });
    const current = deps.draft.get();
    const next = appendDictation(current, formatted.text, lastInsert !== null && current === lastInsert);
    undoStack.push(current);
    deps.draft.set(next);
    lastInsert = next;
    remember(saidText, "dictated into the draft");
    set({ phase: "listening" });
    await say("Added to your message.");
  }

  function setDraft(text: string) {
    undoStack.push(deps.draft.get());
    deps.draft.set(text);
    lastInsert = null;
  }

  const sessionActions: SessionActions = {
    async close() {
      close();
      return { ok: true };
    },
    async stopListening() {
      deps.stopListening();
      return { ok: true };
    },
    async draftSend() {
      if (!deps.draft.available()) return { ok: false, say: "There is no chat input on screen." };
      if (!deps.draft.get().trim()) return { ok: false, say: "The message is empty." };
      await deps.draft.send();
      undoStack.length = 0;
      lastInsert = null;
      return { ok: true };
    },
    async draftRewrite() {
      const draft = deps.draft.available() ? deps.draft.get() : "";
      if (!draft.trim()) return { ok: false, say: "There is nothing to rewrite." };
      set({ said: "Rewriting..." });
      const res = await deps.rpc("rewrite", { draft, chatId: deps.ctx.getActiveChat().chatId, settings: routerSettings(deps.settings()) });
      if (!res.text.trim()) return { ok: false, say: "The rewrite came back empty; I kept your text." };
      setDraft(res.text);
      return { ok: true, say: 'Rewritten. Say "undo" to get your version back.' };
    },
    async draftClear() {
      if (!deps.draft.available()) return { ok: false, say: "There is no chat input on screen." };
      setDraft("");
      return { ok: true };
    },
    async draftRead() {
      const draft = deps.draft.available() ? deps.draft.get() : "";
      if (!draft.trim()) return { ok: false, say: "The message is empty." };
      if (!deps.speak) return { ok: false, say: "Reading aloud needs a newer Lumiverse (host TTS for extensions)." };
      await deps.speak(draft);
      return { ok: true, say: "Done reading." };
    },
    async undo() {
      const previous = undoStack.pop();
      if (previous === undefined) return { ok: false, say: "There is nothing to undo." };
      deps.draft.set(previous);
      lastInsert = null;
      return { ok: true, say: "Undone." };
    },
    async screenControl() {
      const { controls, elements } = collectControls(document, deps.bubbleElement());
      if (!controls.length) return { ok: false, say: "I do not see any controls on screen." };
      const pick = await deps.rpc("domPick", { utterance: currentUtterance, controls, settings: routerSettings(deps.settings()) });
      const control = controls.find((c) => c.id === pick.controlId);
      const el = pick.controlId ? elements.get(pick.controlId) : undefined;
      if (!control || !el) return { ok: false, say: "I could not find that on screen." };
      if (control.destructiveLooking) {
        confirmRun = async () => {
          activateControl(el);
          set({ phase: "listening", options: [] });
          await say(`Clicked "${control.label}".`);
        };
        set({
          phase: "confirming",
          options: [
            { label: "Yes", pick: () => void exclusive(() => confirmed(true)) },
            { label: "No", pick: () => void exclusive(() => confirmed(false)) },
          ],
        });
        return { ok: false, say: `Click "${control.label}"? Are you sure?` };
      }
      const how = activateControl(el);
      return { ok: true, say: `${how === "focused" ? "Focused" : "Clicked"} "${control.label}".` };
    },
  };

  const env = {
    ctx: deps.ctx,
    rpc: deps.rpc,
    surfaces: deps.surfaces,
    generating: deps.generating,
    session: sessionActions,
  };

  offs.push(
    deps.source.onSpeechStart(() => {
      if (phase === "closed") return;
      hearing = true;
      clearTimeout(idleTimer);
      render();
    }),
    deps.source.onBurst((burst) => {
      if (phase === "closed") return;
      hearing = false;
      render();
      void deps.transcriber.transcribe(burst).then(
        (res) => {
          if (res && res.text.trim()) void utterance(res.text);
          else armIdle();
        },
        (error) => void say(`Speech to text failed: ${message(error)}`),
      );
    }),
  );

  return {
    open,
    close,
    /** Typed or clicked input, same path as speech. */
    utterance: (text: string) => utterance(text),
    get phase() {
      return phase;
    },
    startWake,
    stopWake,
    /** Show a status line while closed (mic errors, listening state). */
    notice(text: string) {
      set({ said: text });
    },
    dispose() {
      clearTimeout(idleTimer);
      stopWake();
      for (const off of offs) off();
    },
  };
}

export type Session = ReturnType<typeof createSession>;

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^[A-Z][A-Z0-9_]+:\s*/, "");
}
