import type { AudioSource, WakeDetector, WakeHit } from "./types";

export type WakeStatus =
  | { detector: "kws"; state: "ready" }
  | { detector: "text"; state: "loading_kws"; progress: number }
  | { detector: "text"; state: "kws_failed"; error: string }
  | { detector: "text"; state: "no_wasm" };

/**
 * The on-device keyword spotter when it loads, else the Whistle text match. While the spotter downloads and starts
 * (first use: about 8 MB), the text match listens so "Hey Lumi" works right away.
 */
export function createWakeSelector(options: {
  kws: () => WakeDetector;
  text: WakeDetector;
  onStatus: (status: WakeStatus) => void;
  hasWasm?: boolean;
}): WakeDetector {
  const hasWasm = options.hasWasm ?? typeof WebAssembly === "object";
  let kws: WakeDetector | null = null;
  let loading: Promise<void> | null = null;
  let ready = false;
  let failed = false;
  let active = false;

  if (!hasWasm) options.onStatus({ detector: "text", state: "no_wasm" });

  function loadKws(source: AudioSource, onWake: (hit: WakeHit) => void) {
    kws = options.kws();
    options.onStatus({ detector: "text", state: "loading_kws", progress: 0 });
    loading = kws.start(source, onWake).then(
      () => {
        ready = true;
        options.onStatus({ detector: "kws", state: "ready" });
        // A session may have opened (or the mic stopped) while it loaded.
        if (!active) kws!.stop();
        else options.text.stop();
      },
      (error: unknown) => {
        failed = true;
        options.onStatus({ detector: "text", state: "kws_failed", error: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  return {
    async start(source, onWake) {
      active = true;
      if (ready) return kws!.start(source, onWake);
      await options.text.start(source, onWake);
      if (hasWasm && !failed && !loading) loadKws(source, onWake);
    },
    stop() {
      active = false;
      options.text.stop();
      if (ready) kws?.stop();
    },
  };
}
