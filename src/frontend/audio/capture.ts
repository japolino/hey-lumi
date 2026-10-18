import { createBurstCutter } from "./speech-activity";
import { MicError, SAMPLE_RATE, type MicCapture, type SpeechBurst } from "./types";
import { WORKLET_NAME, workletSource } from "./worklet";

type Listener<T> = (value: T) => void;

function listeners<T>() {
  const set = new Set<Listener<T>>();
  return {
    add(fn: Listener<T>) {
      set.add(fn);
      return () => void set.delete(fn);
    },
    emit(value: T) {
      for (const fn of set) {
        try {
          fn(value);
        } catch (error) {
          console.error("[lumi-voice] audio listener failed", error);
        }
      }
    },
  };
}

function micError(error: unknown): MicError {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return new MicError("denied", "Microphone access was blocked. Allow the microphone for this site in the browser.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MicError("no_device", "No microphone was found.");
  return new MicError("failed", `The microphone could not be opened: ${(error as Error)?.message ?? String(error)}`);
}

/** Own getUserMedia stream -> AudioWorklet (16 kHz frames) -> burst cutter. Driven only by worklet messages. */
export function createMicCapture(): MicCapture {
  const frames = listeners<Float32Array>();
  const bursts = listeners<SpeechBurst>();
  const speechStarts = listeners<void>();
  const pauseReasons = new Set<string>();
  const cutter = createBurstCutter(
    (samples) =>
      bursts.emit({ samples, sampleRate: SAMPLE_RATE, durationMs: (samples.length / SAMPLE_RATE) * 1000, endedAt: performance.now() }),
    () => speechStarts.emit(),
  );
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let starting: Promise<void> | null = null;
  let removeGestureResume: (() => void) | null = null;
  /** Bumped by stop() so a start still in progress releases what it opened. */
  let generation = 0;

  const onFrame = (frame: Float32Array) => {
    if (pauseReasons.size) return;
    frames.emit(frame);
    cutter.push(frame);
  };

  // An AudioContext created without a user gesture stays suspended; resume it on the next click or key.
  const resumeOnGesture = (ctx: AudioContext) => {
    if (ctx.state !== "suspended") return;
    const resume = () => {
      void ctx.resume();
      removeGestureResume?.();
    };
    const events = ["pointerdown", "keydown"] as const;
    for (const e of events) document.addEventListener(e, resume, true);
    removeGestureResume = () => {
      for (const e of events) document.removeEventListener(e, resume, true);
      removeGestureResume = null;
    };
  };

  const release = (media: MediaStream, ctx: AudioContext) => {
    media.getTracks().forEach((t) => t.stop());
    void ctx.close();
    removeGestureResume?.();
  };

  const open = async () => {
    const gen = generation;
    if (!window.isSecureContext)
      throw new MicError("insecure_context", "The microphone needs a secure page: open Lumiverse over https or on localhost.");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined")
      throw new MicError("unsupported", "This browser cannot capture microphone audio.");
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      throw micError(error);
    }
    const ctx = new AudioContext();
    try {
      const url = URL.createObjectURL(new Blob([workletSource()], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, WORKLET_NAME, { channelCount: 1, channelCountMode: "explicit" });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(media).connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      void ctx.resume();
      resumeOnGesture(ctx);
    } catch (error) {
      release(media, ctx);
      throw new MicError("failed", `The audio processor could not start: ${(error as Error)?.message ?? String(error)}`);
    }
    if (gen !== generation) return release(media, ctx);
    for (const track of media.getAudioTracks()) track.onended = () => capture.stop();
    stream = media;
    context = ctx;
  };

  const capture: MicCapture = {
    get running() {
      return !!stream;
    },
    get paused() {
      return pauseReasons.size > 0;
    },
    start() {
      if (stream) return Promise.resolve();
      starting ??= open().finally(() => (starting = null));
      return starting;
    },
    stop() {
      generation++;
      if (stream && context) release(stream, context);
      stream = null;
      context = null;
      cutter.reset();
    },
    setPaused(reason, paused) {
      if (paused) {
        pauseReasons.add(reason);
        cutter.reset();
      } else pauseReasons.delete(reason);
    },
    onFrames: frames.add,
    onBurst: bursts.add,
    onSpeechStart: speechStarts.add,
  };
  return capture;
}
