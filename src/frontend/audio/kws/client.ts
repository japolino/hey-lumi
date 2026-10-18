// Hey Lumi! KWS client: starts the KWS + VAD Worker from cached assets.
// The Worker is a blob URL (index.html CSP allows worker-src 'self' blob:). Audio in: 16 kHz mono Float32 chunks.
import workerSource from './lumi-kws-worker.js' with { type: 'text' }
import { loadKwsAssets } from './assets'

/** Default wake word: "HEY LUMI" in the gigaspeech BPE tokens. Format: tokens [:boost] [#threshold] [@name]. */
export const HEY_LUMI = '▁HE Y ▁ LU M I @HEY_LUMI'

export interface KwsOptions {
  keywords?: string
  keywordsScore?: number       // boost, default 1.0 (2.0 brings "Hey Lou(ie)" false hits)
  keywordsThreshold?: number   // default 0.25
  vad?: { threshold?: number; minSilenceDuration?: number; minSpeechDuration?: number; maxSpeechDuration?: number }
  kwsOn?: boolean              // default true
  vadOn?: boolean              // default false (turn on while the bubble is open)
  onProgress?: (progress: number) => void
  base?: string                // override the pinned asset base URL (tests, mirrors)
}

export type KwsEvent =
  | { type: 'keyword'; keyword: string; at: number; chunkStart: number }   // at = stream sample index (16 kHz)
  | { type: 'speechStart' | 'speechEnd'; at: number }
  | { type: 'segment'; start: number; samples: Float32Array }               // one VAD utterance, 16 kHz
  | { type: 'error'; message: string }

export interface KwsStats { audioSec: number; busyMs: number; heapBytes: number }

export interface KwsHandle {
  push(samples: Float32Array): void          // transfers the buffer
  set(state: { kws?: boolean; vad?: boolean }): void
  flush(): void                               // end the current VAD utterance now
  reset(): void                               // new KWS stream, clear VAD, stream clock back to 0
  sync(): Promise<void>                       // resolves when all audio pushed so far is processed
  stats(): Promise<KwsStats>                  // CPU: busyMs / (audioSec * 1000) = share of one core
  on(listener: (e: KwsEvent) => void): () => void
  dispose(): void
  ready: { version: string; gitSha: string; ms: { wasm: number; kws: number; vad: number } }
}

export async function startKws(opts: KwsOptions = {}): Promise<KwsHandle> {
  const a = await loadKwsAssets(opts.onProgress, opts.base)
  const glue = new TextDecoder().decode(a.glue)
  const url = URL.createObjectURL(new Blob([glue, '\n', workerSource], { type: 'text/javascript' }))
  const worker = new Worker(url)
  URL.revokeObjectURL(url)
  const listeners = new Set<(e: KwsEvent) => void>()
  const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
  const init = {
    type: 'init',
    wasm: buf(a.wasm),
    model: { encoder: buf(a.encoder), decoder: buf(a.decoder), joiner: buf(a.joiner), tokens: buf(a.tokens) },
    vadModel: buf(a.vad),
    kws: { keywords: opts.keywords ?? HEY_LUMI, keywordsScore: opts.keywordsScore ?? 1.0, keywordsThreshold: opts.keywordsThreshold ?? 0.25 },
    vad: { threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.25, maxSpeechDuration: 20, ...opts.vad },
    kwsOn: opts.kwsOn ?? true,
    vadOn: opts.vadOn ?? false,
  }
  const ready = await new Promise<KwsHandle['ready']>((resolve, reject) => {
    worker.onerror = (e) => reject(new Error(e.message || 'KWS worker failed to start'))
    worker.onmessage = (e) => {
      if (e.data.type === 'ready') resolve(e.data)
      else if (e.data.type === 'error') reject(new Error(e.data.message))
    }
    worker.postMessage(init, [init.wasm, init.model.encoder, init.model.decoder, init.model.joiner, init.model.tokens, init.vadModel])
  })
  const pending = new Map<number, (data: any) => void>()
  let nextId = 0
  const ask = <T,>(type: 'ping' | 'stats') => new Promise<T>((resolve) => {
    const id = ++nextId
    pending.set(id, resolve)
    worker.postMessage({ type, id })
  })
  worker.onmessage = (e) => {
    const d = e.data
    if ((d.type === 'pong' || d.type === 'stats') && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return }
    for (const l of listeners) l(d)
  }
  return {
    ready,
    push: (samples) => worker.postMessage({ type: 'audio', samples }, [samples.buffer]),
    set: (state) => worker.postMessage({ type: 'set', ...state }),
    flush: () => worker.postMessage({ type: 'flush' }),
    reset: () => worker.postMessage({ type: 'reset' }),
    sync: () => ask<unknown>('ping').then(() => {}),
    stats: () => ask<KwsStats & { type: 'stats' }>('stats').then(({ audioSec, busyMs, heapBytes }) => ({ audioSec, busyMs, heapBytes })),
    on: (l) => { listeners.add(l); return () => listeners.delete(l) },
    dispose: () => { worker.postMessage({ type: 'dispose' }); listeners.clear() },
  }
}
