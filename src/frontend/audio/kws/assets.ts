// Hey Lumi! KWS assets: pinned URLs, sha256 check, Cache Storage (same approach as the host's
// frontend/src/lib/whistle/assets.ts). Hosted on jsDelivr from japolino/hey-lumi-assets, pinned by commit (spec/kws-wasm.md).

export interface KwsAsset { name: string; path: string; bytes: number; sha256: string }

// Every file is pinned by size and sha256. Change KWS_ASSET_VERSION when any file changes so the cache key changes too.
export const KWS_ASSET_VERSION = '1.13.8-lumi1'
export const KWS_ASSET_BASE = `https://cdn.jsdelivr.net/gh/japolino/hey-lumi-assets@be9dce4d1ccab77f328627b6e2e15d0dec38cc12/kws/`
export const KWS_CACHE = `hey-lumi-kws-${KWS_ASSET_VERSION}`

export const KWS_ASSETS = {
  glue: { name: 'glue', path: 'lumi-kws-vad.js', bytes: 76516, sha256: 'c62d4c23eb09343c733aab7cc2e1fd8438fc5e326af273f183f5e4857ca2ca4f' },
  wasm: { name: 'wasm', path: 'lumi-kws-vad.wasm', bytes: 12791358, sha256: 'bd0fe299438db653f78b5868b23df749cef8dea18753985d905664e542fbe48f' },
  encoder: { name: 'encoder', path: 'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 4807159, sha256: '1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678' },
  decoder: { name: 'decoder', path: 'decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 277985, sha256: 'e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a' },
  joiner: { name: 'joiner', path: 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', bytes: 163380, sha256: 'eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c' },
  tokens: { name: 'tokens', path: 'tokens.txt', bytes: 5006, sha256: 'fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53' },
  vad: { name: 'vad', path: 'silero_vad.onnx', bytes: 643854, sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6' },
} as const satisfies Record<string, KwsAsset>

export type KwsAssetName = keyof typeof KWS_ASSETS
export type KwsAssetBytes = Record<KwsAssetName, Uint8Array>

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function verify(bytes: Uint8Array, asset: KwsAsset): Promise<void> {
  if (bytes.length !== asset.bytes) throw new Error(`Wake word file ${asset.name} is incomplete. Please try again.`)
  if (await sha256Hex(bytes) !== asset.sha256) throw new Error(`Wake word file ${asset.name} could not be verified. Please try again.`)
}

async function download(url: string, asset: KwsAsset, onBytes: (n: number) => void): Promise<Uint8Array> {
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(`Wake word file ${asset.name} could not be downloaded (${response.status}).`)
    const bytes = new Uint8Array(new ArrayBuffer(asset.bytes))
    let written = 0
    const reader = response.body!.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (written + value.length > bytes.length) throw new Error(`Wake word file ${asset.name} has an unexpected size.`)
        bytes.set(value, written)
        written += value.length
        onBytes(value.length)
      }
    } finally { await reader.cancel().catch(() => {}) }
    if (written !== bytes.length) throw new Error(`Wake word file ${asset.name} is incomplete. Please try again.`)
    return bytes
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The wake word download took too long. Please try again.')
    throw error
  } finally { clearTimeout(deadline) }
}

/** Loads all KWS files: Cache Storage first, else the pinned URL. Progress is 0..1 over all bytes. */
export async function loadKwsAssets(onProgress: (progress: number) => void = () => {}, base = KWS_ASSET_BASE): Promise<KwsAssetBytes> {
  let cache: Cache | undefined
  try { cache = await caches.open(KWS_CACHE) } catch { /* storage disabled: download every time */ }
  const list = Object.entries(KWS_ASSETS) as [KwsAssetName, KwsAsset][]
  const total = list.reduce((n, [, a]) => n + a.bytes, 0)
  let done = 0
  const out = {} as KwsAssetBytes
  for (const [key, asset] of list) {
    const url = base + asset.path
    const cached = await cache?.match(url).catch(() => undefined)
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer())
      try {
        await verify(bytes, asset)
        out[key] = bytes
        done += bytes.length
        onProgress(done / total)
        continue
      } catch { await cache?.delete(url).catch(() => {}) }
    }
    const bytes = await download(url, asset, (n) => { done += n; onProgress(done / total) })
    await verify(bytes, asset)
    await cache?.put(url, new Response(bytes as Uint8Array<ArrayBuffer>)).catch(() => { /* quota / private mode must not block the wake word */ })
    out[key] = bytes
  }
  // Old versions are dead weight (about 17 MB each).
  try {
    for (const name of await caches.keys()) if (name.startsWith('hey-lumi-kws-') && name !== KWS_CACHE) await caches.delete(name)
  } catch { /* ignore */ }
  return out
}
