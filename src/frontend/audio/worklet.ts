import { PcmResampler } from "./resampler";

export const WORKLET_NAME = "lumi-voice-capture";
/** 50 ms at 16 kHz. */
export const FRAME_SAMPLES = 800;

/** AudioWorklet module source: resample the first input channel to 16 kHz and post FRAME_SAMPLES frames. */
export function workletSource(): string {
  return `const Resampler = (${PcmResampler.toString()});
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new Resampler(sampleRate);
    this.frame = new Float32Array(${FRAME_SAMPLES});
    this.count = 0;
    this.emit = (s) => {
      this.frame[this.count++] = s;
      if (this.count === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(${FRAME_SAMPLES});
        this.count = 0;
      }
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.resampler.push(channel, this.emit);
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, Capture);
`;
}
