/** Audio pipeline (spec/SPEC.md "Audio (v0)", spec/audio-feasibility.md). */
export * from "./types";
export { createMicCapture } from "./capture";
export { createTranscriber, cleanTranscript } from "./transcriber";
export { createTextWakeDetector, matchWake } from "./wake";
export { watchPauseGates } from "./gates";
export { createBurstCutter } from "./speech-activity";
export { encodeWav } from "./wav";
