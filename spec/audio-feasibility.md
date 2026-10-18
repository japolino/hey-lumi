# Lumi Voice: always-listening audio pipeline, feasibility

Date: 2026-10-18. Host code: Lumiverse `origin/staging` @ 2a8d9461 (worktree `C:/Users/eme4/lv-wt-voice`).
Types: lumiverse-spindle-types `origin/main` @ b4f0842 (0.6.52).
Test machine: AMD Ryzen 3 3300X (4 cores / 8 threads), Windows, Bun 1.4.2.

Tags: **[ran]** = I ran it and measured. **[code]** = I only read code (file:line). **[web]** = docs / web sources, not verified here.

Prototypes and raw results: `C:/Users/eme4/lumi-voice/scratch/audio/` (see "Files" at the end).

## Short answer

- Yes, a frontend extension can run the full always-listening pipeline itself: getUserMedia, AudioWorklet,
  WebAssembly, Workers (blob URLs), and fetches to a CDN all work. Extension frontend code runs in the main Lumiverse
  document, and the host sets no CSP or Permissions-Policy that blocks these.
- **Wake word: sherpa-onnx open-vocabulary keyword spotting (KWS) works well for "HEY LUMI" with no training.**
  On 87 synthetic "Hey Lumi" clips (11 neural voices + 2 SAPI voices, 3 speeds) it found 79 (91%), with 0 false
  triggers on 134 negative clips and 1 false trigger in an 11-minute stream of negative speech, at about 5-6% of one CPU core. [ran]
- The v0 path (cut speech bursts, send each to Whistle, match the text) also works: 70/87 hits, 0/134 false today,
  but it costs about a quarter of a core during speech, uses the host's shared Whistle Worker, and fails more in noise. [ran]
- Whistle (the host's on-device STT) returns punctuation and casing. The native engine also returns word timings with
  probabilities, but `ctx.stt.transcribe` throws them away and returns only `{text, language, provider}`. [ran + code]
- The host gives no signal when its own mic or its TTS starts or stops. An extension must find this out itself
  (DOM `<audio>` events work for the main TTS path), or we add a small host API. [code]
- The mic is open only in a secure context (https or localhost). A user on `http://192.168.x.x` gets no mic at all. [code + web]

## 1. What extension frontend code can do

### How the code is loaded [code]
- The loader fetches `/api/v1/spindle/<id>/frontend?v=<cacheKey>` (frontend/src/lib/spindle/loader.ts:604), turns it into
  a `blob:` URL (loader.ts:949) and runs `import(blobUrl)` (loader.ts:620). The comment at loader.ts:966 says it plainly:
  "Frontend extensions still execute in the Lumiverse document context". So `setup(ctx)` runs with the full `window`:
  `navigator.mediaDevices`, `AudioContext`, `AudioWorklet`, `WebAssembly`, `Worker`, `navigator.gpu`, `caches`, `indexedDB`.
- The host does not wrap or patch `getUserMedia` for extensions (grep of frontend/src: only the host's own engines call it).
  `ctx.stt.*` needs the `media` permission (frontend/src/lib/spindle/frontend-authority-map.ts:141), but a raw
  `navigator.mediaDevices.getUserMedia` call has no Spindle gate; only the browser's own prompt applies.
- Timeouts: bundle download 15 s, module evaluation 10 s (loader.ts:425-426). No size limit was found.
- `ctx.dom.createSandboxFrame` is a different thing: an opaque-origin iframe with `sandbox="allow-scripts"` and
  `allow="... microphone 'none' ..."` (sandbox-frame.ts:123-126). **Do not put audio code in a sandbox frame**; the mic is blocked there.

### CSP and permission headers [code]
- The only CSP on the app page is a meta tag (frontend/index.html:18):
  `frame-src 'self' blob: youtube-nocookie; child-src ...; object-src 'none'; worker-src 'self' blob:;`.
  There is no `script-src` and no `connect-src`. So:
  - WebAssembly compile is allowed (no `script-src`, so no `'wasm-unsafe-eval'` needed).
  - `fetch()` to any CDN is allowed (no `connect-src`). CORS still applies.
  - Workers: only same-origin or `blob:` URLs (`worker-src 'self' blob:`). A worker script on a CDN must be fetched
    and wrapped in a blob URL. AudioWorklet modules follow `script-src`, which is not set, so `blob:` works too.
  - Dynamic `import()` of a CDN `.mjs` (onnxruntime-web does this) is allowed.
- Server headers: src/app.ts:327 sets only `frame-ancestors 'none'` and `X-Frame-Options: DENY` (non-localhost).
  No `Permissions-Policy`, so the top-level page may use the mic.
- No COOP/COEP headers, so the page is **not** `crossOriginIsolated`: no `SharedArrayBuffer`, so no multi-threaded WASM.
  All engines below run single-threaded. This is fine for the small models here. [code; web: ORT falls back to 1 thread]
- The CSP header on the bundle response itself (src/routes/spindle.routes.ts:664) does not matter, because the bundle
  is re-imported as a `blob:` URL.
- Desktop app: Tauri `security.csp` is `null` (desktop/src-tauri/tauri.conf.json).

### Shipping model files of a few MB [code]
- There is **no static-asset route** for extensions. The only served files are the frontend bundle and the widget bundle
  (spindle.routes.ts:596, :634). Versioned bundle URLs are cached `private, max-age=31536000, immutable` (spindle.routes.ts:647).
- Options:
  1. **Fetch from a CDN at first use, then keep in Cache Storage** (recommended). This is what Whistle does for its own
     17.8 MB (frontend/src/lib/whistle/assets.ts: streamed download, sha256 check, `caches.open`). jsDelivr (npm/GitHub),
     Hugging Face `resolve/` URLs and GitHub release assets serve CORS. Pin versions and check sha256.
  2. Inline into `dist/frontend.js` as base64. Works for small files (a 200 KB-1 MB keyword model), but every page load
     downloads (first time) and evaluates it, and the 15 s / 10 s load timeouts apply. Not good for a 10 MB wasm.
  3. Backend `files_fetch` (src/spindle/worker-host-files-api.ts:105) downloads a URL into a host "staged file" and
     `files_download_url` gives a same-origin URL. Needs `cors_proxy`. Staged files look temporary, so this is a
     fallback for CDNs without CORS, not a store.
  4. Host PR: a static `/api/v1/spindle/<id>/assets/*` route from the extension repo. Cleanest long-term, needs upstream agreement.

## 2. `ctx.stt` (stt-api.ts, stt-native.ts)

### What `transcribe(audio)` accepts [code + ran]
- Type (spindle-types src/speech-to-text.ts): `transcribe(audio: Blob | {samples: Float32Array, sampleRate}, options)`.
- Whistle provider: a Blob that `AudioContext.decodeAudioData` can decode (wav, webm/opus, mp3, ...), or mono Float32 PCM
  at 8-192 kHz (whistle/transcribe.ts:49). Max 10 minutes / 64 MiB (transcribe.ts:6-7). It resamples to 16 kHz and cuts
  28 s windows with 1 s overlap (whistle/audio.ts:53-54).
- Connection provider: Blob only (stt-native.ts:66-71). Web Speech: cannot transcribe supplied audio, it throws
  `STT_AUDIO_UNSUPPORTED` (stt-native.ts:60).
- **Result: only `{text, language, provider}`** (stt-native.ts:65; transcribe.ts:87). The word list with timings and
  probabilities exists inside (`WhistleTranscript.words`, whistle/config.ts) but is dropped.
- Whistle is called with keywords = 0 (whistle/runtime.ts:56). The native engine accepts a keywords string. In my test this
  fixed "Lumi" spelling (see section 4), so a host option is worth a PR.
- Cost [ran]: Whistle in Bun, single thread, on the test CPU: model load 91 ms (files already in memory); about 0.22 x real time
  (a 1.4 s clip takes ~0.3 s, a 9 s clip ~1.7 s, a 58 s clip 16.9 s). In a browser it runs in the host's Worker (no main-thread block).

### Mic ownership [code]
- `captureOwner` (stt-api.ts:20) is a module-level lock, but **only between extensions that call `ctx.stt.start`**.
  A second extension gets `STT_BUSY` (stt-api.ts:108). The host's own mic button (InputArea.tsx:3039, `createSTTEngine`)
  does not check or set it.
- If our extension opens its own `getUserMedia` stream, nothing in the host knows. Chrome/Edge/Firefox desktop allow
  several capture streams of the same mic in one page [web]. So our always-on stream does not block the host mic button,
  and the host mic does not block us.
- Real conflicts:
  - **Whistle worker is shared and not re-entrant** (whistle.worker.ts:13 queues all requests). If we push many bursts
    while the user dictates with the host mic, the host waits behind us. A request that takes more than 60 s makes the
    client fail and reject all waiting requests (client.ts:115, `fail()`). Keep bursts short and pause while the host mic is on.
  - Web Speech on Android Chrome takes the mic exclusively; using it next to our own stream can fail [web, not tested].
  - iOS Safari/WKWebView: a new capture can mute an older capture track [web, not tested].
  - Our wake-word stream would hear the user dictating into the host mic. That is harmless if we only act on "Hey Lumi",
    but better to pause.
- How to know the host mic is on: its state is React-local (`sttStatus`, InputArea.tsx:1012). The only outside sign is the
  recording indicator in the DOM (InputArea.tsx ~4400). Watching it with a MutationObserver works but is fragile.

### Host events for its own mic and TTS [code]
- **There are none for extensions.** src/ws/events.ts has only `TTS_CONNECTION_CHANGED` / `STT_CONNECTION_CHANGED`.
  spindle-types has no TTS playback API.
- Inside the host, TTS playback has a ready signal: lib/ttsAudio.ts exports `isSpeaking()` (:488),
  `onTTSEvent('start'|'end'|'error')` (:492) and `subscribeActiveMessage` (:74). Not exposed to extensions.
- What an extension can do today:
  - Auto-play TTS normally plays through the saved-audio `<audio>` element (hooks/useTTSAutoPlay.ts ->
    `synthesizeSaveAndAutoPlay`; components/chat/MessageAudioPlayer.tsx:514). Media events do not bubble, but
    `document.addEventListener('play' | 'pause' | 'ended', h, true)` (capture phase) sees them. Good enough for v0.
  - The in-memory fallback and the per-message play button use Web Audio (`AudioContext`, ttsAudio.ts:12). That is
    invisible from the DOM.
  - `ctx.systemAudio` (permission `system_audio`, desktop client only) gives levels/spectrum of what the device plays
    (spindle-types permissions.ts:41-43). It asks the user on every start. Possible but heavy for this.
  - `getUserMedia({audio: {echoCancellation: true}})` (the default) reduces TTS leaking into the mic, but browser AEC
    is not reliable for audio played through a separate `AudioContext` on every platform [web]. Pausing is safer.
- **Recommended host PR (small):** `ctx.voice.onActivity(cb)` with `{kind: 'tts' | 'host_stt', active: boolean}`,
  built from `onTTSEvent`/`subscribeActiveMessage` and `sttStatus`. Plus `transcribe(..., {words: true, keywords})`.

## 3. Whistle output quality for dictation [ran]

Setup: Windows SAPI voices (David, Zira) and Microsoft Edge neural voices (via `edge-tts`), converted to 16 kHz mono PCM16.
Run through the host's own code: `frontend/src/lib/whistle/runtime.ts` + `transcribe.ts` (the same path as
`ctx.stt.transcribe` with Whistle, minus the Worker), with the pinned assets from `frontend/public/stt/whistle/`.
Script: `scratch/audio/whistle_run.ts`. Synthetic voices are cleaner than real people; treat these as best-case numbers.

| Spoken text | Whistle text |
|---|---|
| She leans against the doorframe and smiles. "You came back," she says quietly. I wonder if she knows what I did. | She leans against the door frame and smiles. "You came back," she says quietly. "I wonder if she knows what I did." |
| I draw my sword and step between them. "Stay behind me, Seo-yeon. Nobody touches her." Out of character, can we skip to the next morning? | I draw my sword and step between them." "Stay behind me." "Seo Yeon." "Nobody touches her." "Out of character. Can we skip to the next morning?" |
| Wait, really? Okay, okay. Then I guess we head north, to the old mill, before the storm hits. Do you have the map? | Wait, really. Okay, okay. Then I guess we had north to the old mill before the storm hits. Do you have the map?" |
| That's about it, I don't need anything else. | That's about it. I don't need anything else." |
| Hey Lumi. Switch the connection profile to Claude and start a new chat with the red haired one. | HAY LUMY Switch the connection profile to claw and start a new chat with the red haired one. |

Findings:
- **Punctuation and casing: yes**, mostly good. Sentence ends and commas are right most of the time; "?" is sometimes lost.
- **Quotation marks: yes, but unreliable.** The model sometimes adds `"` around sentences that were not dialogue and
  leaves stray closing quotes. For RP formatting we should **strip all `"` from Whistle output** and let Jev's
  per-sentence labels decide what is dialogue (as DESIGN.md already plans). The same ~58 s narration run lost all quotes.
- **Occasional ALL-CAPS** for short or unclear phrases ("HAY LUMY", "LUMY OPEN BREACEITS"). Normalise case when a whole
  segment is upper case.
- **Word timings: yes, in the native result** (`words: [{word, start, end, probability}]`, 10-20 ms grid), with
  per-word probability. Not available through `ctx.stt.transcribe` today (see 2).
- Long audio: a 58 s clip was split into three windows; one word ("I") was lost at a window seam.
- Names: "Claude" -> "claw", "Seo-yeon" -> "Seo Yeon". The keywords bias (not exposed) should help for character names.
- **Web Speech** [code + web]: the host passes only `result[0].transcript` and `isFinal` (sttEngine.ts:235); no
  confidence, no timings. Punctuation depends on the browser (Chrome's cloud recogniser usually gives little or none;
  Apple's recogniser adds it). It needs a live mic session and cannot transcribe a Blob, so it does not fit a
  "transcribe this burst" design.

## 4. Wake word "Hey Lumi"

### Test set [ran]
- Positives (87): "Hey Lumi." and "Hey Lumi, open the character list." in 11 Edge neural voices (US/GB/AU/IN, adult and child)
  x 3 speeds (-20%, 0, +25%) = 66; plus 21 SAPI clips (David, Zira; 3 speeds; "Hey Lumi.", "Hey Lumi!", "Hey Lumi, go to settings.").
- Negatives (134 clips): per voice "Hey Lucy, can you pass the salt?", "Welcome back to Lumiverse.", "That plan is completely
  loony.", "I told Lumi about it yesterday.", "Hey, look at me!", "Hey Louie, come here.", "Hey Lou, me and you are late.",
  two RP dictation paragraphs and one normal-talk paragraph; plus SAPI RP clips, "Okay Lumi ...", "Lumi, open presets",
  "Hey Jarvis ...".
- Long negative stream: all negatives back to back, 11.0 minutes.
- Noisy copies of the positives: white noise at 15 dB SNR.
- All audio is synthetic TTS. Real voices, room echo, and music will be worse. Before shipping we need a few minutes of
  real recordings from the user.

### Comparison (best first)

| Option | Licence | Shipped size | CPU (test PC, 1 thread) | Custom "hey lumi" | Result here |
|---|---|---|---|---|---|
| **sherpa-onnx KWS** (zipformer gigaspeech 3.3M, int8) | Apache-2.0 (code + model) | browser wasm ~10.6 MB (community build) + model 5.25 MB (int8 encoder 4.8 + decoder 0.28 + joiner 0.16 + tokens) | ~5-6% of one core (RTF 0.054-0.062) [ran] | **No training**: write tokens in a keywords file | **79/87 hits, 0/134 false, 1 false in 11 min**; noisy 64/87 [ran] |
| openWakeWord (openwakeword-js / openwakeword_wasm / deepcorelabs) | code Apache-2.0 / MIT; **pretrained models CC BY-NC-SA 4.0** | onnxruntime-web wasm 12.3 MB + mel 1.1 MB + embedding 1.3 MB + keyword 0.2-1.3 MB (+ silero VAD 1.8 MB) | 6-9 ms per 80 ms frame = ~8-11% of one core [ran] | Needs training (Colab / openwakeword.com, ~1 h, synthetic voices) | "hey jarvis" stand-in: 6/6 hits (score 0.99), 0/7 negatives [ran] |
| Whistle + text match (v0) | Apache-2.0 (in host) | 0 extra (host ships it) | ~0.24 x real time, but only on speech bursts | Free: just regex | 70/87 clean, 47/87 noisy, 0/134 false today; 75 / 77 / 1 with keywords [ran] |
| Porcupine Web (Picovoice) | closed, AccessKey checked at start | ~1-2 MB | very low [web] | Console, seconds | **Not an option**: Picovoice ended the free tier on 30 June 2026; the SDK will not start without a paid key [web] |
| microWakeWord | Apache-2.0 | ~50-100 KB TFLite micro model | very low | Training (microwakeword.com / notebook) | No browser runtime; built for ESP32. Would need a TFLite-wasm or ONNX port [web] |

#### sherpa-onnx KWS details [ran]
- Package used for the test: npm `sherpa-onnx` 1.13.8 (the official wasm build for Node, NODERAWFS). Same C++ engine as the
  browser wasm build. Model from release tag `kws-models`. Script: `scratch/audio/sherpa/kws_run.ts`, audio fed in 100 ms chunks
  like a live mic, stream reset after each hit.
- Keyword line (tokens from the model's `bpe.model`, tokenised with sentencepiece):
  ```
  ▁HE Y ▁ LU M I @HEY_LUMI
  ```
  "LUMI" is not one BPE token; it becomes `▁ LU M I` (a lone word-start `▁`, then `LU`, `M`, `I`). Other spellings:
  `HEY LOOMY` -> `▁HE Y ▁LO OM Y`, `HEY LUMEE` -> `▁HE Y ▁ LU ME E`, `HAY LUMI` -> `▁HA Y ▁ LU M I`,
  `HEY LUCY` -> `▁HE Y ▁ LU C Y`. Format: `tokens [:boost] [#threshold] [@display]`, no space after `:` / `#`.
  `sherpa-onnx-cli text2token` (pip `sherpa-onnx`) does the tokenising; at runtime the extension can just ship the fixed line.
- Settings tried (global `keywordsScore` = boost, `keywordsThreshold`; maxActivePaths 4, numTrailingBlanks 1):

  | Config | Hits /87 | False /134 clips | False in 11 min |
  |---|---|---|---|
  | **A: one line, boost 1.0, threshold 0.25 (defaults)** | **79** | **0** | **1** ("Hey Lou, me and you") |
  | threshold 0.15 | 79 | 0 | 1 |
  | threshold 0.35 | 73 | 0 | 1 |
  | boost 2.0 | 79 | 4 (Lou/Louie, "Okay Lumi") | 1 |
  | boost 1.5, threshold 0.20 | 79 | 2 | 1 |
  | 4 spellings (LUMI, LOOMY, LUMEE, HAY LUMI) | 77 | 1 | 0 |
  | 4 spellings, threshold 0.20 | 77 | 1 | 0 |
  | A with fp32 model | 80 | 0 | 1 |

  Use config A. Extra spellings did not help. Raising the boost brings in "Hey Lou(ie)" false triggers.
- Misses (8): 3 clips from a child voice/Indian-English voice where Whistle also hears "He Lumi" / "cab to list";
  2 where the TTS itself said "Hey Lord" / "A Lumi"; "Hey Louis" (Guy, fast). So most misses are bad audio, not the spotter.
- No false trigger on "Hey Lucy", "Lumiverse", "loony", "I told Lumi about it", RP, or normal talk in isolation.
- Latency: the hit comes ~0.5 s after the end of "Lumi" (mean 0.52 s, max 0.66 s, with 100 ms chunks).
- Noise: with white noise at 15 dB SNR, 64/87 (74%). Real background noise needs testing.
- CPU: RTF 0.054-0.062 alone (5-6% of one core); int8 and fp32 cost about the same here.
- Browser build: `wasm/kws` in the repo (`sherpa-onnx-kws.js`, `sherpa-onnx-wasm-main-kws.cc`, `build-wasm-simd-kws.sh`,
  emsdk 4.0.23). **There is no official prebuilt browser KWS wasm** (k2-fsa issue #3112); a community HF space
  (`yuiyide/sherpa-oon-kws`) has one: wasm 10.6 MB + glue JS 93 KB (its .data file with models is 37 MB, we would ship
  int8 only). We must build it ourselves once (Emscripten in CI or WSL) and host it with the model on a CDN.
  By default the build bakes models into a `.data` file; for us it is better to write the downloaded model files into
  the Emscripten FS at runtime (`Module.FS.writeFile`) so the model can change without rebuilding.
  The engine is single-threaded here (no `SharedArrayBuffer`), which is what I measured.
- Other sherpa-onnx pieces that fit [ran unless noted]:
  - **Silero VAD in wasm**: 644 KB model, RTF 0.011 (~1% core) on the 11-minute stream; 238 speech segments, mean 1.65 s.
    Official browser demo: HF space `k2-fsa/web-assembly-vad-sherpa-onnx` (wasm 12.6 MB + .data 645 KB).
    If one custom wasm build has both KWS and VAD, they share one runtime.
  - **Punctuation**: `sherpa-onnx-online-punct-en-2024-08-06` (int8 7.5 MB, English, also restores case). Result on
    lower-case RP text: "She leans against the doorframe and smiles. You came back. She says quietly. I wonder if she
    knows what I did". Worse than what Whistle already outputs, so **not needed** with Whistle. The C API exists in the
    wasm build, but there is no official browser punctuation demo [web].
  - **Streaming ASR** (zipformer transducer, e.g. 20M English): would give live partial text in the bubble. Bigger
    (tens of MB) and lower quality than Whistle for final text. Not needed for v0/v1 [web].

#### openWakeWord details
- [ran] openwakeword-js 0.1.27 (Apache-2.0, bundles its own onnxruntime-web 1.24.1) with the `hey_jarvis_v0.1.onnx` model:
  6/6 "Hey Jarvis" clips peaked at 0.996-0.999; 0.000 on "Hey Lumi" clips, RP and "Hey Lucy". So **"hey jarvis" can stand in
  during development**, but it is a different phrase, and its models are **non-commercial (CC BY-NC-SA 4.0)**.
- Packages [web]: `openwakeword-js` (Firoj Paudel, Apache-2.0, Feb 2026, pipeline with Silero VAD gating);
  `openwakeword-wasm-browser` / github dnavarrom/openwakeword_wasm (MIT, Nov 2025, `WakeWordEngine` with AudioWorklet,
  based on the deepcorelabs post). The deepcorelabs post explains the pipeline: 1280-sample chunks, mel `x/10+2`,
  76-frame mel window, 16-embedding window, VAD as confirmation with a hangover.
- Custom "hey lumi": train with the openWakeWord `automatic_model_training.ipynb` (Colab; users report it often breaks)
  or openwakeword.com (free; its terms say generated models are personal / non-commercial by default). About 1 hour.
  sherpa-onnx makes this step unnecessary.

#### v0: speech-activity detection + Whistle on each burst + text match [ran]
- Note: `frontend/src/lib/speechDetection.ts` is **not** voice activity detection. It splits TTS text into
  quoted/asterisked segments (`parseSegments`, speechDetection.ts:294). The host's audio detector is
  `SpeechActivityDetector` in whistle/audio.ts:131 (RMS with a noise floor, 140 ms to confirm speech, ends after 1.6 s silence)
  and a similar one in sttEngine.ts (connection recorder). Not exported to extensions; easy to copy (~25 lines).
- Results on the same test set, each clip treated as one speech burst. Match rule: the text **starts** with
  "hey"/"hay" followed by "lumi" (`/^\W*(hey|hay)\W{0,3}\s*lumi\b/i`).

  | Whistle mode | Clean hits /87 | Noisy (15 dB) /87 | False /134 |
  |---|---|---|---|
  | as `ctx.stt.transcribe` works today (no keywords) | 70 | 47 | 0 |
  | with native keywords = "Lumi" (needs a host change) | 75 | 77 | 1 ("Hey Lou, me and you" -> "Hey, Lumi and you") |

  A looser match (also "okay", "a", "louis") reaches 83-84/87 but then **every "Hey Louie, come here" (11/11) and every
  "Okay Lumi" matches**. Do not match "Louis".
  Earlier small SAPI test: without keywords an isolated "Hey Lumi." came out as "Hey, looming.", "Hey, Louis.",
  "HAY LUMY"; with keywords all 34 SAPI clips had the word "Lumi". sherpa KWS and Whistle mostly miss the same bad clips (6 of 8 shared).
- Noise: Whistle with keywords held up better in white noise (77/87) than sherpa KWS (64/87). Without keywords it falls to 47/87.
- Cost: every speech burst is transcribed, about 0.24 x its length on this CPU, in the shared host Worker. In a room with
  lots of talk (or TTS leaking in), that is steady CPU use and it competes with the host mic.
- A text match also triggers on "Lumi" in normal dictation unless the match requires "hey" at the start of the burst.

## 5. Platform notes

- **Secure context**: getUserMedia needs https or localhost (Whistle checks it, whistle/config.ts:24). Self-hosted
  Lumiverse opened as `http://<LAN-IP>:7860` has **no mic**. Show a clear message.
- **Background tabs (desktop Chrome/Edge/Firefox)** [web]: an active capture keeps the AudioWorklet (audio thread) and
  Workers running; Chrome does not freeze or discard tabs that use the mic. Main-thread timers are throttled (1 per second
  or less) in hidden tabs. So drive the pipeline from worklet `port.onmessage` / Worker messages, not from `setTimeout`.
  Browsers show a "using your microphone" indicator for the whole time.
- **Lumiverse desktop app** (Tauri v2) [code]: the main UI is a Tauri `WebviewWindow` that loads the server URL directly
  (desktop/src-tauri/src/frontend.rs). Windows = WebView2 with `--disable-background-timer-throttling` (frontend.rs:132),
  and webview_visibility.rs keeps scripts running while hidden. macOS = WKWebView with `NSMicrophoneUsageDescription`
  and the audio-input entitlement. Linux = WebKitGTK; the app turns on MediaStream and shows its own mic prompt
  (webview_media.rs:33, called from frontend.rs:796). WebKitGTK and WKWebView support WASM and AudioWorklet; WebGPU is not needed.
- **iOS app** (ios/): WKWebView, mic prompt allowed for the trusted frame (ios/native/ios/Sources/NativeBridge.swift:88-91).
  iOS suspends web content when the app goes to the background or the screen locks, so always-listening works only in the foreground.
- **Android app** (android/, prototype): AndroidManifest.xml has only `INTERNET`, no `RECORD_AUDIO`, so getUserMedia should
  fail there [code, not run]. Android Chrome (PWA) works in the foreground; background behaviour is not tested.
- **Mobile browsers** in general: battery cost of an always-on mic plus ~5% of a big core is real. Offer
  "listen only while Lumiverse is visible" (Page Visibility API) as the default on mobile.

## Recommended pipeline

### v0 (no new host APIs, no own models)
1. On user opt-in (click), open one `getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}})`
   stream in the extension. Capture with an AudioWorklet (blob URL) that resamples to 16 kHz (copy the host's `PcmResampler` idea).
2. Copy the host's `SpeechActivityDetector` logic to cut bursts (max ~6 s, ignore bursts < 0.4 s).
3. Send each burst as `{samples, sampleRate: 16000}` to `ctx.stt.transcribe(..., {provider: 'whistle', language: 'en'})`.
4. Wake if the text starts with "hey/hay" + "lumi" (also accept "lumy", "loomy"; never "louis"). The rest of the burst is the first command.
   Measured: 70/87 clean, 0/134 false. Real voices will be worse; v1 fixes this.
5. Pause listening while the host mic indicator is visible and while any `<audio>` element plays (capture-phase media events).
6. In the open bubble, keep using the same stream + Whistle for commands and dictation; strip `"` and fix ALL-CAPS segments.

### v1 (recommended target)
1. Same capture stream and AudioWorklet.
2. **sherpa-onnx in one custom wasm build (KWS + Silero VAD)**, in a Worker, single-threaded, with the int8 gigaspeech KWS model
   and the keyword line `▁HE Y ▁ LU M I @HEY_LUMI` (boost 1.0, threshold 0.25). About 16-17 MB, downloaded once from a
   pinned CDN URL, checked with sha256, kept in Cache Storage. About 6-7% of one core while listening.
3. On a hit: play a short sound, open the bubble, and keep a 1-2 s ring buffer so the words right after "Hey Lumi" are not lost.
4. Inside the bubble: Silero VAD cuts utterances; each goes to `ctx.stt.transcribe` (user's STT choice; Whistle by default).
5. Small host PRs (prolix-oc/Lumiverse + spindle-types):
   - `ctx.voice.onActivity` (TTS playing / host mic recording) so we pause without DOM tricks.
   - `ctx.stt.transcribe(..., {words: true, keywords?: string})` to return Whistle word timings and pass the keyword bias.
   - Optional: static asset route for extension files, so models need no external CDN.
6. Let the user lower the threshold in a hidden/advanced setting only if real-voice tests show misses (user prefers working defaults).

### Open risks
- All accuracy numbers come from synthetic voices. Record 20-30 real "Hey Lumi" samples and 30 minutes of the user's
  normal RP session (with TTS playing) before fixing thresholds.
- Building the sherpa-onnx browser wasm is a one-time CI task we have not done yet.
- The shared Whistle Worker can be busy; a stuck request (> 60 s) fails all pending host requests.

## Files
- `scratch/audio/make_clips.ps1`, `make_wake.ps1` - SAPI clip generation. `clips/` - all test audio (`clips/edge/` neural voices,
  `clips/noisy/` 15 dB copies, `clips/long_negative.wav` 11-min stream).
- `scratch/audio/whistle_run.ts`, `whistle_kw.ts`, `whistle_kw2.ts` - Whistle through the host's runtime.ts / transcribe.ts;
  outputs `whistle_out.json`, `whistle_kw_out.json`, `wh_all.json`.
- `scratch/audio/sherpa/kws_run.ts` (+ `cfg_*.json`, `out_*.json`) - sherpa-onnx KWS runs; `vad_punct.ts` - VAD + punctuation.
- `scratch/audio/oww/oww_run.ts` - openWakeWord "hey jarvis" run.
- Host worktree used: `C:/Users/eme4/lv-wt-voice` (detached at origin/staging 2a8d9461, no changes).
