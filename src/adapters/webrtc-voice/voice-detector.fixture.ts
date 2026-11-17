import type { VoiceDetectorConfig } from "../../voice/index.js";

/** A voice detector for tests, tuned as the game's is. */
export const VOICE_DETECTOR: VoiceDetectorConfig = {
  minLevel: 0.3,
  band: { low: 300, high: 3400 },
  minBandShare: 0.4,
  maxFlatness: 0.3,
  maxZeroCrossings: 0.2,
  onsetSeconds: 0.1,
  hangoverSeconds: 0.35,
};
