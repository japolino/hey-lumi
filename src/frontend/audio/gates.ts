import { CAP, hasCap, type FrontendCtx } from "../../shared/host-ext";
import type { MicCapture } from "./types";

/**
 * The host composer's recording panel: the only <button> with aria-live in the host UI
 * (InputArea.tsx, shown while its STT is starting, listening or processing).
 */
export const HOST_MIC_SELECTOR = "button[aria-live]";

const PLAYING = ["play", "playing"];
const STOPPED = ["pause", "ended", "emptied"];

/** Audible media elements that play (muted background videos do not count). */
function watchMedia(onChange: (playing: boolean) => void): () => void {
  const playing = new Set<HTMLMediaElement>();
  const audible = (el: HTMLMediaElement) => !el.paused && !el.ended && !el.muted && el.volume > 0;
  const update = (el: HTMLMediaElement) => {
    const before = playing.size > 0;
    if (audible(el)) playing.add(el);
    else playing.delete(el);
    if (before !== playing.size > 0) onChange(playing.size > 0);
  };
  const handler = (event: Event) => {
    if (event.target instanceof HTMLMediaElement) update(event.target);
  };
  const events = [...PLAYING, ...STOPPED, "volumechange"];
  // Media events do not bubble; the capture phase still sees them at the document.
  for (const e of events) document.addEventListener(e, handler, true);
  document.querySelectorAll<HTMLMediaElement>("audio, video").forEach(update);
  return () => {
    for (const e of events) document.removeEventListener(e, handler, true);
  };
}

function watchHostMicDom(onChange: (active: boolean) => void): () => void {
  let active = false;
  const check = () => {
    const now = !!document.querySelector(HOST_MIC_SELECTOR);
    if (now !== active) onChange((active = now));
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { childList: true, subtree: true });
  check();
  return () => observer.disconnect();
}

/** Pause the capture while host TTS plays ("tts") and while the host composer mic records ("host_mic"). */
export function watchPauseGates(ctx: FrontendCtx, capture: MicCapture): () => void {
  const tts = (on: boolean) => capture.setPaused("tts", on);
  const hostMic = (on: boolean) => capture.setPaused("host_mic", on);
  const stops: Array<() => void> = [];

  if (ctx.tts && hasCap(ctx.host, CAP.tts)) {
    stops.push(ctx.tts.subscribe(tts));
    tts(ctx.tts.isSpeaking());
  } else stops.push(watchMedia(tts));

  if (ctx.stt?.onHostActivity) {
    stops.push(ctx.stt.onHostActivity(hostMic));
    hostMic(ctx.stt.isHostCapturing?.() ?? false);
  } else stops.push(watchHostMicDom(hostMic));

  return () => {
    for (const stop of stops) stop();
    tts(false);
    hostMic(false);
  };
}
