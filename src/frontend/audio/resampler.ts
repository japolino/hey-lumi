/**
 * Streaming area resampler to 16 kHz (copy of the host's PcmResampler, whistle/audio.ts). Self-contained on purpose:
 * its source text is also loaded into the AudioWorklet.
 */
export class PcmResampler {
  ratio: number;
  remaining: number;
  weighted = 0;

  constructor(sourceRate: number) {
    this.ratio = sourceRate / 16000;
    this.remaining = this.ratio;
  }

  push(input: Float32Array, emit: (sample: number) => void): void {
    for (const sample of input) {
      const value = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      let available = 1;
      while (available > 1e-9) {
        const weight = Math.min(available, this.remaining);
        this.weighted += value * weight;
        available -= weight;
        this.remaining -= weight;
        if (this.remaining < 1e-9) {
          emit(this.weighted / this.ratio);
          this.remaining = this.ratio;
          this.weighted = 0;
        }
      }
    }
  }
}
