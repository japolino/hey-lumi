/**
 * Lumi Voice frontend: mic + speech-activity bursts, wake word, the session bubble, and running actions on the host.
 */
import { CAP, hasCap, type FrontendCtx, type HostSurfaceInfo } from "./shared/host-ext";
import { DEFAULT_SETTINGS, normalizeSettings, SETTINGS_KEY, type LumiVoiceSettings } from "./shared/settings";
import { createMicCapture, createTextWakeDetector, createTranscriber, matchWake, MicError, watchPauseGates, type WakeDetector } from "./frontend/audio/index";
import { createBubble, type PillState } from "./frontend/bubble";
import { buildCandidates, createFrontendEntities } from "./frontend/candidates";
import { createDraft } from "./frontend/draft";
import { createRpc } from "./frontend/rpc";
import { createSession } from "./frontend/session";
import { renderSettingsPanel } from "./frontend/settings-panel";

const LISTENING_KEY = "voice:listening";
const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

export function setup(rawCtx: unknown) {
  const ctx = rawCtx as FrontendCtx;
  const cleanups: Array<() => void> = [];
  let settings: LumiVoiceSettings = DEFAULT_SETTINGS;

  const rpc = createRpc(ctx);
  cleanups.push(() => rpc.dispose());

  let surfaces: HostSurfaceInfo[] = ctx.host.surfaces?.list() ?? [];
  let fallbackSettings: HostSurfaceInfo[] = [];
  let candidates = buildCandidates(surfaces);
  const offSurfaces = ctx.host.surfaces?.subscribe((next) => {
    surfaces = next;
    candidates = buildCandidates(next, fallbackSettings);
    entities.invalidate();
  });
  if (!surfaces.some((s) => s.kind === "settings_tab")) {
    rpc.call("settingsTabs", {}).then(
      (tabs) => {
        fallbackSettings = tabs.map((t) => ({ kind: "settings_tab", ...t }));
        candidates = buildCandidates(surfaces, fallbackSettings);
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
  const textWake = createTextWakeDetector(transcriber);
  const wake = (): WakeDetector | null => (settings.wakeWord ? textWake : null);
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

  let pill: PillState = { mic: "off", title: "Lumi Voice: click to start listening" };
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
    generating,
    ...(speak ? { speak } : {}),
    bubbleElement: () => bubble.element,
    render: (view) => bubble.render(view),
  });
  cleanups.push(() => session.dispose());

  let stopGates: (() => void) | null = null;
  async function startListening() {
    if (capture.running) return;
    setPill({ mic: "starting", title: "Lumi Voice: starting the microphone..." });
    try {
      rpc.call("listNames", {}).then((list) => void (names = list), () => {});
      await capture.start();
      stopGates = watchPauseGates(ctx, capture);
      await session.startWake();
      setPill({ mic: "listening", title: settings.wakeWord ? 'Lumi Voice: say "Hey Lumi" (or click)' : "Lumi Voice: click to talk" });
      void ctx.settings?.set(LISTENING_KEY, true);
    } catch (error) {
      const text = error instanceof MicError || error instanceof Error ? error.message : String(error);
      setPill({ mic: "error", title: `Lumi Voice: ${text}` });
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
    setPill({ mic: "off", title: "Lumi Voice: click to start listening" });
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
    id: "lumi_voice",
    title: "Lumi Voice",
    shortName: "Voice",
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
    status: () => pill.title.replace(/^Lumi Voice: /, ""),
    support,
    backendProfiles: () => rpc.call("listProfiles", {}),
  });
  cleanups.push(tab.onActivate(() => void refreshPanel()));

  const action = ctx.ui.registerInputBarAction({ id: "lumi_voice_toggle", label: "Lumi Voice", subtitle: "Start or stop listening", iconSvg: MIC_ICON });
  cleanups.push(action.onClick(toggleListening), () => action.destroy());

  void (async () => {
    settings = normalizeSettings(await ctx.settings?.get(SETTINGS_KEY));
    const off = ctx.settings?.watch(SETTINGS_KEY, (value) => void (settings = normalizeSettings(value)));
    if (off) cleanups.push(off);
    // The mic and audio graph start on the first click after a reload (browsers want a user gesture for audio).
    if (await ctx.settings?.get<boolean>(LISTENING_KEY)) {
      const resume = () => void startListening();
      document.addEventListener("pointerdown", resume, { once: true, capture: true });
      cleanups.push(() => document.removeEventListener("pointerdown", resume, { capture: true }));
      setPill({ mic: "off", title: "Lumi Voice: click anywhere to resume listening" });
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
