/**
 * Hey Lumi! frontend: mic + speech-activity bursts, wake word, the session bubble, and running actions on the host.
 */
import { CAP, hasCap, type FrontendCtx, type HostSurfaceInfo } from "./shared/host-ext";
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type HeyLumiSettings } from "./shared/settings";
import { createMicCapture, createTextWakeDetector, createTranscriber, matchWake, MicError, watchPauseGates, type WakeDetector } from "./frontend/audio/index";
import { KwsWakeDetector } from "./frontend/audio/kws/kws-wake-detector";
import { createWakeSelector, type WakeStatus } from "./frontend/audio/wake-select";
import { createBubble, type PillState } from "./frontend/bubble";
import { buildCandidates, createFrontendEntities } from "./frontend/candidates";
import { createDraft } from "./frontend/draft";
import { createRpc } from "./frontend/rpc";
import { createSession } from "./frontend/session";
import { renderSettingsPanel } from "./frontend/settings-panel";

const LISTENING_KEY = "voice:listening";
const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

function wakeText(status: WakeStatus): string {
  if (status.detector === "kws") return "Wake word: on-device detector.";
  if (status.state === "loading_kws") return `Wake word: downloading the on-device detector (${Math.round(status.progress * 100)}%); speech-to-text match until then.`;
  if (status.state === "kws_failed") return `Wake word: speech-to-text match (on-device detector unavailable: ${status.error}).`;
  return "Wake word: speech-to-text match (this browser has no WebAssembly).";
}

export function setup(rawCtx: unknown) {
  const ctx = rawCtx as FrontendCtx;
  const cleanups: Array<() => void> = [];
  let settings: HeyLumiSettings = DEFAULT_SETTINGS;

  const rpc = createRpc(ctx);
  cleanups.push(() => rpc.dispose());

  let surfaces: HostSurfaceInfo[] = ctx.host.surfaces?.list() ?? [];
  let fallbackSettings: HostSurfaceInfo[] = [];
  let ready = false;
  let candidates = buildCandidates(surfaces);
  const refreshCandidates = () => void (candidates = buildCandidates(surfaces, fallbackSettings, ownOwner()));
  const offSurfaces = ctx.host.surfaces?.subscribe((next) => {
    surfaces = next;
    refreshCandidates();
    entities.invalidate();
  });
  if (!surfaces.some((s) => s.kind === "settings_tab")) {
    rpc.call("settingsTabs", {}).then(
      (tabs) => {
        fallbackSettings = tabs.map((t) => ({ kind: "settings_tab", ...t }));
        refreshCandidates();
      },
      () => {},
    );
  }
  if (offSurfaces) cleanups.push(offSurfaces);
  const entities = createFrontendEntities(ctx, () => surfaces);

  const generatingChats = new Set<string>();
  const chatOf = (payload: unknown) => String((payload as { chatId?: string; chat_id?: string } | null)?.chatId ?? (payload as { chat_id?: string } | null)?.chat_id ?? "");
  cleanups.push(
    ctx.events.on("GENERATION_STARTED", (p) => void generatingChats.add(chatOf(p))),
    ctx.events.on("GENERATION_ENDED", (p) => void generatingChats.delete(chatOf(p))),
    ctx.events.on("GENERATION_STOPPED", (p) => void generatingChats.delete(chatOf(p))),
  );
  const generating = () => {
    const chat = ctx.getActiveChat().chatId;
    return !!chat && generatingChats.has(chat);
  };

  const capture = createMicCapture();
  let names: string[] = [];
  const transcriber = createTranscriber(ctx, () => settings.profiles.stt, () => names);
  const wakeLine = document.createElement("small");
  wakeLine.textContent = "Wake word: starts with the microphone.";
  const showWake = (status: WakeStatus) => {
    wakeLine.textContent = wakeText(status);
    document.querySelector<HTMLElement>("[data-hey-lumi]")?.setAttribute("data-wake", status.detector);
  };
  const wakeDetector = createWakeSelector({
    kws: () => new KwsWakeDetector({ onProgress: (progress) => showWake({ detector: "text", state: "loading_kws", progress }) }),
    text: createTextWakeDetector(transcriber),
    onStatus: showWake,
  });
  const wake = (): WakeDetector | null => (settings.wakeWord ? wakeDetector : null);
  const tts = ctx.tts && hasCap(ctx.host, CAP.tts) ? ctx.tts : null;
  const speak = tts
    ? async (text: string) => {
        capture.setPaused("lumi_tts", true);
        try {
          await tts.speak({ text }, settings.profiles.tts ? { connectionId: settings.profiles.tts } : {});
        } finally {
          capture.setPaused("lumi_tts", false);
        }
      }
    : undefined;

  let pill: PillState = { mic: "off", title: "Hey Lumi! · click to start listening" };
  const setPill = (next: PillState) => {
    pill = next;
    bubble.pill(next);
  };

  const session = createSession({
    ctx,
    rpc: rpc.call,
    draft: createDraft(ctx),
    source: capture,
    transcriber,
    wake,
    matchWake,
    settings: () => settings,
    surfaces: () => surfaces,
    candidates: () => candidates,
    entities: () => entities.get(),
    stopListening: () => stopListening(),
    generating,
    ...(speak ? { speak } : {}),
    bubbleElement: () => bubble.element,
    render: (view) => bubble.render(view),
  });
  cleanups.push(() => session.dispose());

  let stopGates: (() => void) | null = null;
  async function startListening() {
    if (capture.running) return;
    setPill({ mic: "starting", title: "Hey Lumi! · starting the microphone..." });
    try {
      rpc.call("listNames", {}).then((list) => void (names = list), () => {});
      await capture.start();
      stopGates = watchPauseGates(ctx, capture);
      // The first start downloads the on-device wake word; the text match listens meanwhile.
      void session.startWake();
      setPill({ mic: "listening", title: settings.wakeWord ? 'Hey Lumi! · say "Hey Lumi" (or click)' : "Hey Lumi! · click to talk" });
      void ctx.settings?.set(LISTENING_KEY, true);
    } catch (error) {
      const text = error instanceof MicError || error instanceof Error ? error.message : String(error);
      setPill({ mic: "error", title: `Hey Lumi! · ${text}` });
      session.notice(text);
    }
    void refreshPanel();
  }
  function stopListening() {
    session.close();
    session.stopWake();
    stopGates?.();
    stopGates = null;
    capture.stop();
    setPill({ mic: "off", title: "Hey Lumi! · click to start listening" });
    void ctx.settings?.set(LISTENING_KEY, false);
    void refreshPanel();
  }
  const toggleListening = () => (capture.running ? stopListening() : void startListening());
  cleanups.push(() => {
    stopGates?.();
    capture.stop();
  });

  const bubble = createBubble({
    onPill: () => {
      if (capture.running) session.open();
      else void startListening();
    },
    onClose: () => session.close(),
    onType: (text) => void session.utterance(text),
  });
  cleanups.push(() => bubble.destroy());
  bubble.pill(pill);
  bubble.render({ phase: "closed", heard: "", said: "", options: [], hearing: false });

  const support = () => {
    const has = (kind: string, id: string) => surfaces.some((s) => s.kind === kind && s.id === id);
    return [
      { name: "Speech to text (ctx.stt)", ok: !!ctx.stt && hasCap(ctx.host, CAP.stt) },
      { name: "Jev decisions", ok: hasCap(ctx.host, CAP.decisions) },
      { name: "Chat input access (ctx.composer)", ok: !!ctx.composer && hasCap(ctx.host, CAP.composer) },
      { name: "Stop / swipe commands", ok: has("command", "action-stop-generation") },
      { name: "Persona, preset, theme, new-chat actions", ok: has("entity_action", "character_chat") },
      { name: "Profiles of every kind", ok: hasCap(ctx.host, CAP.connectionKinds) },
      { name: "Host TTS (ctx.tts)", ok: !!tts },
      { name: "STT keywords + host mic activity", ok: hasCap(ctx.host, CAP.sttOptions) },
      { name: "Microphone (https or localhost)", ok: window.isSecureContext },
    ];
  };

  const tab = ctx.ui.registerDrawerTab({
    id: "hey_lumi",
    title: "Hey Lumi!",
    shortName: "Lumi",
    description: "Voice control and dictation settings",
    keywords: ["voice", "lumi", "dictation", "microphone", "wake word", "hey lumi"],
    iconSvg: MIC_ICON,
  });
  cleanups.push(() => tab.destroy());
  const refreshPanel = renderSettingsPanel({
    ctx,
    root: tab.root,
    settings: () => settings,
    save: (next) => {
      settings = next;
      void ctx.settings?.set(SETTINGS_KEY, next);
      if (capture.running && session.phase === "closed") {
        session.stopWake();
        void session.startWake();
      }
    },
    listening: () => capture.running,
    toggleListening,
    status: () => pill.title.replace(/^Hey Lumi! · /, ""),
    wakeLine,
    support,
    backendProfiles: () => rpc.call("listProfiles", {}),
  });
  cleanups.push(tab.onActivate(() => void refreshPanel()));

  const action = ctx.ui.registerInputBarAction({ id: "hey_lumi_toggle", label: "Hey Lumi!", subtitle: "Start or stop listening", iconSvg: MIC_ICON });
  cleanups.push(action.onClick(toggleListening), () => action.destroy());
  /** The catalog's owner id for Hey Lumi!'s own entries (the host uses its extension id). */
  function ownOwner(): string | undefined {
    if (!ready) return undefined;
    return surfaces.find((s) => (s.kind === "drawer_tab" && s.id === tab.tabId) || (s.kind === "input_bar_action" && s.id === action.actionId))?.owner;
  }
  ready = true;
  refreshCandidates();

  void (async () => {
    settings = normalizeSettings(await ctx.settings?.get(SETTINGS_KEY));
    const off = ctx.settings?.watch(SETTINGS_KEY, (value) => void (settings = normalizeSettings(value)));
    if (off) cleanups.push(off);
    // The mic and audio graph start on the first click after a reload (browsers want a user gesture for audio).
    if (await ctx.settings?.get<boolean>(LISTENING_KEY)) {
      const resume = () => void startListening();
      document.addEventListener("pointerdown", resume, { once: true, capture: true });
      cleanups.push(() => document.removeEventListener("pointerdown", resume, { capture: true }));
      setPill({ mic: "off", title: "Hey Lumi! · click anywhere to resume listening" });
    }
  })();

  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {
        // Keep tearing down the rest.
      }
    }
  };
}
