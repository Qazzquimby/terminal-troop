import type { RadioSoundConfig } from "../../voice/index.js";

/** A speaker's sound for tests: round numbers, worse at worst in every way. */
export const RADIO_SOUND: RadioSoundConfig = {
  band: { low: 250, high: 3500 },
  honk: { frequency: 2000, gain: 4, q: 2 },
  crunch: { clean: 2, worst: 8, makeup: 0.5, steps: 16 },
  hiss: { clean: 0.05, worst: 0.4 },
  squelch: { volume: 0.5, open: 0.1, close: 0.25 },
  dropout: {
    clean: 0.1,
    worst: 3,
    length: { min: 0.1, max: 0.2 },
    depth: 0.1,
    swell: 2,
  },
  crackle: {
    clean: 0.5,
    worst: 5,
    length: { min: 0.02, max: 0.05 },
    volume: 1,
  },
};
