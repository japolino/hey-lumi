# Lumi Voice: sherpa-onnx KWS + Silero VAD in the browser (v1 groundwork)

Date: 2026-10-18. Test machine: AMD Ryzen 3 3300X (4 cores / 8 threads), Windows 11, Chrome 153.0.8010.48 (headless, Playwright).
Tags: **[ran]** = I ran it and measured. **[code]** = I only read code. **[web]** = docs or memory, not checked here.

## Short answer

- One custom wasm module has both keyword spotting (KWS) and Silero VAD. It is single-threaded, so it needs no
  COOP/COEP. It runs in a classic blob-URL Worker in Chrome. [ran]
- In the Worker it gives **exactly the earlier Node numbers**: 79/87 "Hey Lumi" hits, 0/134 false triggers,
  1 false trigger in the 11-minute negative stream (same clip "Hey Lou, me and you", same time 210.6 s).
  All 222 clips give the same hits at the same times as `scratch/audio/sherpa/out_A.json`. [ran]
- VAD gives exactly the earlier result too: 238 segments, mean 1.65 s, on the 11-minute stream. [ran]
- Live path (Chrome fake mic -> AudioContext 16 kHz -> AudioWorklet -> Worker), one 16.7-minute stream:
  **75/87 hits, 0 false triggers in 11 minutes, no double hits**. KWS + VAD together use **7.4% of one core**. [ran]
- Download: **18.8 MB raw, about 8.0 MB gzip** (wasm 12.8 MB, KWS model 5.25 MB, VAD 0.64 MB, glue 77 KB).
  Start: about **1.2 s** from cached files to "ready" (wasm compile 30-40 ms, KWS model init 0.9-1.1 s, VAD 12-19 ms). [ran]
- Hosting: **GitHub release assets cannot be fetched from the browser** (no CORS header, `TypeError: Failed to fetch`
  in Chrome). jsDelivr and Hugging Face work. Proposal: jsDelivr from a small assets repo, pinned by commit. [ran]

## Files

Build and test (untracked scratch, `C:/Users/eme4/lumi-voice/scratch/kws-wasm/`):
- `build.sh` - reproducible build script (Linux/WSL). `overlay/CMakeLists.txt`, `overlay/lumi-kws-vad.cc` - our wasm target.
- `dist/` - build output: `lumi-kws-vad.js` (glue), `lumi-kws-vad.wasm`, `SHA256SUMS`, `BUILD-INFO.txt`.
- `make_manifest.py` + `assets.template.ts` - copy files to `assets/` (the CDN layout) and write the pinned manifest.
- `run_tests.py` (Playwright, local static server) + `web/test.js` - the browser tests. `out_*.json` - raw results.
- `web/mic_stream.wav` + `web/mic_truth.json` - the 16.7-minute fake-mic stream and its clip timeline.

Proposal for the extension (`C:/Users/eme4/lumi-voice/src/frontend/audio/kws/`, not wired in, not committed):
- `assets.ts` - pinned manifest (size + sha256 per file), download, sha256 check, Cache Storage. Same approach as the
  host's `frontend/src/lib/whistle/assets.ts` (origin/staging 2a8d9461).
- `lumi-kws-worker.js` (+ `.d.ts`) - the Worker. Packs the sherpa-onnx C config structs, writes models to MEMFS.
- `client.ts` - `startKws(options) -> KwsHandle`: loads assets, starts the Worker, typed events.
- `kws-wake-detector.ts` - `KwsWakeDetector` implements the extension lead's `WakeDetector` (`../types.ts`).
- Type check: passes with the repo tsconfig settings (`bunx tsc -p scratch/kws-wasm/tsconfig.kws.json`, exit 0). [ran]
  `client.ts` and the Worker ran in the browser tests. `kws-wake-detector.ts` is only type-checked, not run.

## Build

`bash scratch/kws-wasm/build.sh` on Linux or WSL (I used WSL Ubuntu 26.04, no root). [ran]
1. Installs cmake 3.31 + ninja with uv into `$WORK/venv` (default `WORK=~/kws-wasm`).
   cmake 4.x was not tried; sherpa-onnx's dependencies may need `cmake_minimum_required` fixes there.
2. emsdk **4.0.23** (the version sherpa-onnx names as known to work).
3. sherpa-onnx tag **v1.13.8** (commit 11afbd009a7f, the same version as the npm package used for the earlier numbers).
   The script checks the commit.
4. Copies `overlay/` over `sherpa-onnx/wasm/kws/` (so the upstream `SHERPA_ONNX_ENABLE_WASM_KWS` switch builds our target),
   then cmake + ninja with TTS, speaker diarization, websocket, portaudio and binaries off. ONNX Runtime comes
   prebuilt from sherpa-onnx's pinned download (`onnxruntime-wasm-static_lib-simd-1.28.2.zip`, sha256 checked by cmake).
5. Copies `lumi-kws-vad.js` and `lumi-kws-vad.wasm` to `dist/` and writes `SHA256SUMS`.
Full build: about 6-7 minutes on this PC (252 steps, -j8). Then `python make_manifest.py <version> <base-url>`.

Differences from upstream `wasm/kws` (sherpa-onnx v1.13.8 `wasm/kws/CMakeLists.txt`):
- No `--preload-file`: no `.data` file. Models are written to MEMFS at runtime (`Module.FS.writeFile`), so the model
  and the keyword line can change without a rebuild.
- VAD C functions exported too (the VAD C API is always compiled into the C API lib; no `#if`). [code]
- `-sMODULARIZE=1 -sEXPORT_NAME=createLumiKwsModule -sENVIRONMENT=worker`: a factory for a classic Worker. The wasm bytes
  come from Cache Storage and are passed as `wasmBinary`, so the glue never fetches anything.
- `INITIAL_MEMORY` 64 MB instead of 512 MB (with `ALLOW_MEMORY_GROWTH`). The heap stayed at 64 MB in all runs. [ran]
- Single-threaded, SIMD (the ORT lib is the SIMD build). No pthreads, no SharedArrayBuffer.
- Not checked: whether two builds give a byte-identical wasm. The manifest pins whatever was built and uploaded.

Size options I tried (link step only): `-O3` (used) 12.79 MB, `-Oz` 11.93 MB, `-O2` 13.06 MB. `-Oz` saves 0.87 MB;
I did not measure its speed, so I kept `-O3`. Most of the wasm is the full ONNX Runtime; a smaller one needs a
custom ORT "minimal build" with only the operators these models use (not tried).

## Sizes [ran]

| File | Bytes | gzip -9 | sha256 (first 12) |
|---|---|---|---|
| lumi-kws-vad.wasm | 12,791,358 | 3,459,026 | bd0fe299438d |
| lumi-kws-vad.js (glue) | 76,516 | 20,708 | c62d4c23eb09 |
| encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx | 4,807,159 | 3,663,646 | 1e7216765151 |
| decoder-...int8.onnx | 277,985 | 208,791 | e40ff43297ab |
| joiner-...int8.onnx | 163,380 | 128,804 | eae9da0c7e1e |
| tokens.txt | 5,006 | 2,459 | fd2ded4050a5 |
| silero_vad.onnx | 643,854 | 508,078 | 9e2449e10874 |
| **Total** | **18,765,258** | **7,991,512** | full hashes in `assets.ts` |

Model sources: KWS model from the sherpa-onnx release tag `kws-models`
(`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`), Silero VAD from the release tag `asr-models`
(`silero_vad.onnx`; sha256 matches the release file, checked with curl). Both Apache-2.0 / MIT (Silero) [web].
Cache Storage use after load: 18.77 MB (`navigator.storage.estimate`). [ran]

## Test results [ran]

Same keyword line and settings as config A in `spec/audio-feasibility.md`:
`▁HE Y ▁ LU M I @HEY_LUMI`, boost 1.0, threshold 0.25, maxActivePaths 4, numTrailingBlanks 1, int8 model.

| Run | Hits /87 | False /134 clips | False in 11-min stream | CPU (share of one core) |
|---|---|---|---|---|
| Node, npm sherpa-onnx (earlier, `out_A.json`) | 79 | 0 | 1 | 5.4% (KWS) |
| **Chrome Worker, per clip** (same feeding as Node: 0.5 s lead, 1 s tail, 100 ms chunks, new stream per clip) | **79** | **0** | **1** (210.6 s, "Hey Lou") | **6.0%** (KWS) |
| Chrome Worker, the 16.7-min stream as one file, no resets except after a hit | 77 | - | 1 (same place) | - |
| **Chrome fake mic, live** (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=mic_stream.wav%noloop`) | **75** | - | **0** | **7.4%** (KWS + VAD) |
| VAD only, 11-min stream, 512-sample chunks (minSilence 0.3, minSpeech 0.25) | 238 segments, mean 1.65 s (same as Node) | | | 1.1% |

Notes:
- The per-clip run matches the Node run clip by clip (0 differences in hits or hit times). So the browser build is
  the same engine; only the speed differs (6.0% vs 5.4%).
- The fake-mic stream is the 87 positives (1.5 s silence between them) and then the 11-minute negative stream.
  Hits were matched to clips by time (the stream clock was 0.23 s ahead of the file, found by matching VAD segment
  starts to clip starts; median error 0.05 s). The fake mic goes 16 kHz file -> Chrome's capture rate -> AudioContext
  at 16 kHz, so it is resampled twice. The 4 extra misses vs the per-clip run come from the continuous stream (2) and
  the resampling (2); with synthetic voices this is within noise. Missed in both: child and Indian-English voices,
  "Guy fast" (as in the feasibility report).
- VAD in the live run: 339 segments (237 in the 11-minute part).
- Hit timing in the live run, "Hey Lumi." only clips: the hit came on average 0.54 s **before** the clip file ended
  (the TTS files have trailing silence), at most 0.36 s after it.
- CPU is the time spent inside the Worker's wasm calls divided by audio time (`busyMs / audioSec`). Main-thread and
  AudioWorklet cost are not included (small: one 100 ms message each way).
- Memory: wasm heap 64 MB (no growth), plus about 19 MB for the cached files while they are passed in.

## Load time [ran]

Local static server (so network time is near 0), 3 runs each, `startKws()` until "ready":

| Case | Total | wasm compile+instantiate | KWS create (incl. MEMFS writes) | VAD create |
|---|---|---|---|---|
| Cold (empty cache: fetch + sha256 + cache put) | 1.20-1.22 s | 32-38 ms | 0.92-0.95 s | 12-19 ms |
| Warm (Cache Storage hit + sha256) | 1.15-1.21 s | 29-34 ms | 1.05-1.12 s | 12-15 ms |

- KWS create is the big part (ONNX Runtime session setup for 3 models). Node takes the same, 1.09 s. It runs in the
  Worker, so the page does not freeze. `KwsWakeDetector` keeps the Worker loaded between sessions for this reason.
- Over a real network the first start also downloads about 8 MB (compressed by jsDelivr). Not measured here.
- Chrome compiles the wasm lazily (fast first tier), so "wasm 30-40 ms" is not the full optimised compile.

## Worker message interface

The Worker is a classic script: a blob of `[lumi-kws-vad.js glue, '\n', lumi-kws-worker.js]`
(index.html CSP allows `worker-src 'self' blob:`). All audio is 16 kHz mono Float32. Positions (`at`, `start`) are
sample indexes on the stream clock, which starts at 0 on `init` and on `reset`.

Main -> Worker:
| Message | Meaning |
|---|---|
| `{type:'init', wasm, model:{encoder, decoder, joiner, tokens}, vadModel?, kws:{keywords, keywordsScore?, keywordsThreshold?, maxActivePaths?, numTrailingBlanks?}, vad?:{threshold?, minSilenceDuration?, minSpeechDuration?, maxSpeechDuration?}, kwsOn?, vadOn?}` | All buffers are ArrayBuffers (transferred). `kwsOn` default true, `vadOn` default false. |
| `{type:'audio', samples: Float32Array}` | Any length; the client sends 100 ms (1600 samples). Transfer the buffer. |
| `{type:'set', kws?: boolean, vad?: boolean}` | Turn KWS / VAD on or off. Turning KWS on resets its decoder; turning VAD off clears it. |
| `{type:'flush'}` | End the current VAD utterance now (emits its `segment`). |
| `{type:'reset'}` | New KWS stream, VAD cleared, stream clock to 0. |
| `{type:'ping', id}` | Answered with `pong` after all earlier audio is processed. |
| `{type:'stats', id}` | Answered with `stats`. |
| `{type:'dispose'}` | Worker closes itself. |

Worker -> main:
| Message | Meaning |
|---|---|
| `{type:'ready', version, gitSha, ms:{wasm, kws, vad}}` | After `init`. `version` = "1.13.8". |
| `{type:'keyword', keyword:'HEY_LUMI', at, chunkStart}` | A hit at the end of the chunk that ends at `at`. The KWS stream is reset after each hit. |
| `{type:'speechStart' \| 'speechEnd', at}` | VAD state change (only while VAD is on). |
| `{type:'segment', start, samples}` | One VAD utterance (Float32Array, transferred). |
| `{type:'pong', id}`, `{type:'stats', id, audioSec, busyMs, heapBytes}` | Replies. CPU share = `busyMs / (audioSec * 1000)`. |
| `{type:'error', message}`, `{type:'log', text}` | Errors from a message handler; stderr of the wasm. |

`client.ts` wraps this as `KwsHandle { push, set, flush, reset, sync(), stats(), on(listener), dispose, ready }`.

Use in the extension (v1): KWS on and VAD off while waiting for the wake word. On `keyword`: open the bubble,
`set({kws:false, vad:true})`, send each `segment` to `ctx.stt.transcribe`. On close: `reset()`, `set({kws:true, vad:false})`.
The 1-2 s ring buffer for words right after "Hey Lumi" (feasibility report, v1 step 3) belongs in the capture code, not in the Worker.

## Hosting proposal (nothing published)

Checked from a `http://localhost` page in Chrome with `fetch()` [ran]:
- GitHub release asset (`github.com/.../releases/download/...`): **fails** (`TypeError: Failed to fetch`). The 302 to
  `release-assets.githubusercontent.com` has no `Access-Control-Allow-Origin`. So a GitHub release cannot be the URL.
- jsDelivr (`cdn.jsdelivr.net/npm/...` with a .onnx file): works. Headers: `access-control-allow-origin: *`,
  `Cache-Control: public, max-age=31536000, immutable`, `Content-Encoding: br` for .wasm and .onnx.
- Hugging Face `resolve/` (model repo): works; redirects to its CDN with CORS. No compression (full 18.8 MB).

Proposal:
1. **Primary: jsDelivr from a GitHub repo** `japolino/lumi-voice-assets` (separate repo, so the extension repo stays
   small), files under `kws/`, URL pinned by commit: `https://cdn.jsdelivr.net/gh/japolino/lumi-voice-assets@<commit>/kws/`.
   About 8 MB transfer thanks to compression. The sha256 check in `assets.ts` protects against a moved tag.
   jsDelivr has per-file and per-repo size limits [web, not checked: about 20 MB per file and 50 MB per GitHub repo];
   our largest file is 12.8 MB. I did not test a `gh/` URL because the repo does not exist yet.
2. **Mirror: Hugging Face model repo** `japolino/lumi-voice-kws`, `resolve/<commit>/`. Same manifest, other base URL.
   `loadKwsAssets(onProgress, base)` already takes the base, so a fallback is one retry with the mirror base.
3. Alternative: an npm package (jsDelivr `npm/` URLs are immutable per version), but it needs an npm account.
4. Long term: the host static asset route for extensions (feasibility report, option 4) would remove the CDN.

`assets.ts` now has the placeholder base `https://cdn.jsdelivr.net/gh/japolino/lumi-voice-assets@kws-1.13.8-lumi1/kws/`
and version `1.13.8-lumi1`. After upload: run `make_manifest.py <version> <base-url-with-commit>`.

## Licences [web]
sherpa-onnx (code and the gigaspeech KWS model): Apache-2.0. ONNX Runtime: MIT. Silero VAD: MIT. Emscripten runtime: MIT.
The config packing in `lumi-kws-worker.js` follows sherpa-onnx `wasm/kws/sherpa-onnx-kws.js` and
`wasm/vad/sherpa-onnx-vad.js` (Apache-2.0); keep the attribution comment.

## Open points
- Real voices and real rooms (all numbers here are synthetic TTS).
- Speed of the `-Oz` build; a minimal ONNX Runtime build to cut the 12.8 MB wasm.
- Firefox / Safari / WebKitGTK / the Tauri webviews: not tested (only Chrome 153).
- Real CDN download time on a slow line; the 120 s download timeout is copied from Whistle.
