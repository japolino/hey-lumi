// v1 wake detector: sherpa-onnx KWS on the extension's own 16 kHz frames (WakeDetector from ../types).
// The worker stays loaded between start/stop (its init takes 2-3 s); dispose() frees it.
import type { AudioSource, WakeDetector, WakeHit } from '../types'
import { startKws, type KwsHandle, type KwsOptions } from './client'

export class KwsWakeDetector implements WakeDetector {
  private handle: Promise<KwsHandle> | undefined
  private unsubscribe: (() => void)[] = []

  constructor(private readonly options: KwsOptions = {}) {}

  async start(source: AudioSource, onWake: (hit: WakeHit) => void): Promise<void> {
    this.stop()
    this.handle ??= startKws(this.options)
    let kws: KwsHandle
    try { kws = await this.handle } catch (error) { this.handle = undefined; throw error }
    kws.reset()
    kws.set({ kws: true })
    this.unsubscribe.push(
      kws.on((e) => { if (e.type === 'keyword') onWake({ rest: '' }) }),
      source.onFrames((samples) => kws.push(samples.slice())),
    )
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off()
    void this.handle?.then((kws) => kws.set({ kws: false }), () => {})
  }

  dispose(): void {
    this.stop()
    void this.handle?.then((kws) => kws.dispose(), () => {})
    this.handle = undefined
  }
}
