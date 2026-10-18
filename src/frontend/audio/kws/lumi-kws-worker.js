// Lumi Voice KWS + VAD worker (classic Worker script).
// The loader builds the Worker from a blob: [lumi-kws-vad.js (Emscripten glue, defines createLumiKwsModule), this file].
// Config packing follows sherpa-onnx v1.13.8 wasm/kws/sherpa-onnx-kws.js and wasm/vad/sherpa-onnx-vad.js (Apache-2.0),
// checked against the static_asserts in lumi-kws-vad.cc. Pointers and ints are 4 bytes (wasm32).
'use strict';

const SAMPLE_RATE = 16000;
let M = null;          // Emscripten module
let kws = 0, kwsStream = 0, vad = 0;
let kwsOn = true, vadOn = false;
let pcmPtr = 0, pcmCap = 0;
let samplesIn = 0;     // samples received since init/reset (stream clock for event positions)
let samplesTotal = 0;  // samples received since init (for CPU stats)
let busyMs = 0;        // time spent in wasm for audio
let inSpeech = false;

function cstr(strings) {
  // Packs strings into one malloc'd block; returns {base, ptrs[]}.
  const lens = strings.map((s) => M.lengthBytesUTF8(s) + 1);
  const base = M._malloc(lens.reduce((a, b) => a + b, 0));
  const ptrs = [];
  let off = base;
  strings.forEach((s, i) => { M.stringToUTF8(s, off, lens[i]); ptrs.push(off); off += lens[i]; });
  return { base, ptrs };
}

function createKws(c) {
  // SherpaOnnxKeywordSpotterConfig = feat(2) + online model(transducer 3, paraformer 2, zipformer2 ctc 1,
  // tokens, num_threads, provider, debug, model_type, modeling_unit, bpe_vocab, tokens_buf, tokens_buf_size,
  // nemo ctc 1, t-one ctc 1) + max_active_paths, num_trailing_blanks, keywords_score, keywords_threshold,
  // keywords_file, keywords_buf, keywords_buf_size.
  const s = cstr(['/m/encoder.onnx', '/m/decoder.onnx', '/m/joiner.onnx', '/m/tokens.txt', 'cpu', '', 'bpe', '', '', '', c.keywords]);
  const [enc, dec, joi, tok, prov, mtype, unit, bpe, tokBuf, kwFile, kwBuf] = s.ptrs;
  const words = 2 + 3 + 2 + 1 + 9 + 1 + 1 + 7;
  const p = M._malloc(words * 4);
  M.HEAPU8.fill(0, p, p + words * 4);
  const i32 = (i, v) => M.setValue(p + i * 4, v, 'i32');
  const f32 = (i, v) => M.setValue(p + i * 4, v, 'float');
  i32(0, SAMPLE_RATE); i32(1, 80);
  i32(2, enc); i32(3, dec); i32(4, joi);
  // 5,6 paraformer; 7 zipformer2 ctc
  i32(8, tok); i32(9, 1); i32(10, prov); i32(11, 0); i32(12, mtype); i32(13, unit); i32(14, bpe); i32(15, tokBuf); i32(16, 0);
  // 17 nemo ctc; 18 t-one ctc
  i32(19, c.maxActivePaths ?? 4); i32(20, c.numTrailingBlanks ?? 1);
  f32(21, c.keywordsScore ?? 1.0); f32(22, c.keywordsThreshold ?? 0.25);
  i32(23, kwFile); i32(24, kwBuf); i32(25, M.lengthBytesUTF8(c.keywords));
  const h = M._SherpaOnnxCreateKeywordSpotter(p);
  M._free(p); M._free(s.base);
  if (!h) throw new Error('KWS init failed (bad model or keywords line)');
  return h;
}

function createVad(c) {
  // SherpaOnnxVadModelConfig = silero(model, threshold, min_silence, min_speech, window_size, max_speech)
  // + sample_rate, num_threads, provider, debug + ten_vad(same 6 fields).
  const s = cstr(['/m/silero_vad.onnx', 'cpu', '']);
  const [model, prov, empty] = s.ptrs;
  const p = M._malloc(16 * 4);
  M.HEAPU8.fill(0, p, p + 16 * 4);
  const i32 = (i, v) => M.setValue(p + i * 4, v, 'i32');
  const f32 = (i, v) => M.setValue(p + i * 4, v, 'float');
  i32(0, model); f32(1, c.threshold ?? 0.5); f32(2, c.minSilenceDuration ?? 0.5); f32(3, c.minSpeechDuration ?? 0.25);
  i32(4, 512); f32(5, c.maxSpeechDuration ?? 20);
  i32(6, SAMPLE_RATE); i32(7, 1); i32(8, prov); i32(9, 0);
  i32(10, empty); f32(11, 0.5); f32(12, 0.5); f32(13, 0.25); i32(14, 256); f32(15, 20);
  const h = M._SherpaOnnxCreateVoiceActivityDetector(p, c.bufferSizeInSeconds ?? 30);
  M._free(p); M._free(s.base);
  if (!h) throw new Error('VAD init failed');
  return h;
}

function upload(samples) {
  if (pcmCap < samples.length) { if (pcmPtr) M._free(pcmPtr); pcmPtr = M._malloc(samples.length * 4); pcmCap = samples.length; }
  M.HEAPF32.set(samples, pcmPtr >> 2);
}

function feed(samples) {
  const t0 = performance.now();
  upload(samples);
  const chunkStart = samplesIn;
  samplesIn += samples.length;
  samplesTotal += samples.length;
  if (kwsOn && kws) {
    M._SherpaOnnxOnlineStreamAcceptWaveform(kwsStream, SAMPLE_RATE, pcmPtr, samples.length);
    while (M._SherpaOnnxIsKeywordStreamReady(kws, kwsStream)) {
      M._SherpaOnnxDecodeKeywordStream(kws, kwsStream);
      const r = M._SherpaOnnxGetKeywordResult(kws, kwsStream);
      const json = JSON.parse(M.UTF8ToString(M.getValue(r + 24, 'i32')));
      M._SherpaOnnxDestroyKeywordResult(r);
      if (json.keyword) {
        M._SherpaOnnxResetKeywordStream(kws, kwsStream);
        postMessage({ type: 'keyword', keyword: json.keyword, at: samplesIn, chunkStart });
      }
    }
  }
  if (vadOn && vad) {
    M._SherpaOnnxVoiceActivityDetectorAcceptWaveform(vad, pcmPtr, samples.length);
    drainVad();
  }
  busyMs += performance.now() - t0;
}

function drainVad() {
  const detected = M._SherpaOnnxVoiceActivityDetectorDetected(vad) === 1;
  if (detected !== inSpeech) { inSpeech = detected; postMessage({ type: detected ? 'speechStart' : 'speechEnd', at: samplesIn }); }
  while (M._SherpaOnnxVoiceActivityDetectorEmpty(vad) !== 1) {
    const h = M._SherpaOnnxVoiceActivityDetectorFront(vad);
    const start = M.HEAP32[h >> 2], ptr = M.HEAP32[(h >> 2) + 1], n = M.HEAP32[(h >> 2) + 2];
    const seg = M.HEAPF32.slice(ptr >> 2, (ptr >> 2) + n);
    M._SherpaOnnxDestroySpeechSegment(h);
    M._SherpaOnnxVoiceActivityDetectorPop(vad);
    postMessage({ type: 'segment', start, samples: seg }, [seg.buffer]);
  }
}

async function init(msg) {
  const t0 = performance.now();
  M = await createLumiKwsModule({ wasmBinary: msg.wasm, print: () => {}, printErr: (s) => postMessage({ type: 'log', text: s }) });
  const tWasm = performance.now();
  M.FS.mkdir('/m');
  const put = (name, data) => M.FS.writeFile('/m/' + name, new Uint8Array(data));
  put('encoder.onnx', msg.model.encoder); put('decoder.onnx', msg.model.decoder);
  put('joiner.onnx', msg.model.joiner); put('tokens.txt', msg.model.tokens);
  kws = createKws(msg.kws);
  kwsStream = M._SherpaOnnxCreateKeywordStream(kws);
  for (const f of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx']) M.FS.unlink('/m/' + f); // ORT keeps its own copy
  const tKws = performance.now();
  if (msg.vadModel) { put('silero_vad.onnx', msg.vadModel); vad = createVad(msg.vad || {}); M.FS.unlink('/m/silero_vad.onnx'); }
  const tVad = performance.now();
  kwsOn = msg.kwsOn ?? true; vadOn = !!vad && (msg.vadOn ?? false);
  postMessage({ type: 'ready', version: M.UTF8ToString(M._SherpaOnnxGetVersionStr()), gitSha: M.UTF8ToString(M._SherpaOnnxGetGitSha1()),
    ms: { wasm: tWasm - t0, kws: tKws - tWasm, vad: tVad - tKws } });
}

function reset() {
  // A fresh stream also drops buffered features, so the next audio starts clean.
  if (kws) { M._SherpaOnnxDestroyOnlineStream(kwsStream); kwsStream = M._SherpaOnnxCreateKeywordStream(kws); }
  if (vad) { M._SherpaOnnxVoiceActivityDetectorReset(vad); inSpeech = false; }
  samplesIn = 0;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': await init(m); break;
      case 'audio': feed(m.samples); break;
      case 'set':
        if ('kws' in m) { kwsOn = m.kws; if (kwsOn) M._SherpaOnnxResetKeywordStream(kws, kwsStream); }
        if ('vad' in m) { vadOn = m.vad && !!vad; if (!vadOn && vad) { M._SherpaOnnxVoiceActivityDetectorReset(vad); inSpeech = false; } }
        break;
      case 'flush':
        if (vad && vadOn) { M._SherpaOnnxVoiceActivityDetectorFlush(vad); drainVad(); }
        break;
      case 'reset': reset(); break;
      case 'ping': postMessage({ type: 'pong', id: m.id }); break;
      case 'stats': postMessage({ type: 'stats', id: m.id, audioSec: samplesTotal / SAMPLE_RATE, busyMs, heapBytes: M.HEAPU8.length }); break;
      case 'dispose': close(); break;
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
