/*
 * Tells speech from the other things a mic picks up: the hum of a room, a fan's hiss, the clack
 * of keys. A frame of samples looks like speech when its loudness sits in the speech band
 * (300-3400 Hz), its spectrum is peaky rather than flat (a voice's harmonics, not a hiss), and it
 * crosses zero no faster than a voice does. Speech starts only once frames have looked like it
 * for a short run, so a click is never speech, and lasts a little past the last frame that did,
 * so the gaps inside and between words don't chop it.
 */

import type { VoiceDetectorConfig } from "../../voice/index.js";
import { rmsLevel } from "./mic.js";

/** What a frame is judged on. */
export interface VoiceFeatures {
  /** RMS loudness, -1..1 samples. */
  readonly rms: number;
  /** Share of the power (DC aside) in the speech band, 0..1. */
  readonly bandShare: number;
  /** Geometric over arithmetic mean of the power in the speech band, 0..1. */
  readonly flatness: number;
  /** Sign changes per sample, 0..1. */
  readonly zeroCrossings: number;
}

/** The `i`th of `values`, 0 past its end. */
const at = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

/** In-place radix-2 FFT of `re` and `im`, whose length is a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const swapRe = at(re, i);
      re[i] = at(re, j);
      re[j] = swapRe;
      const swapIm = at(im, i);
      im[i] = at(im, j);
      im[j] = swapIm;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tRe = at(re, b) * cRe - at(im, b) * cIm;
        const tIm = at(re, b) * cIm + at(im, b) * cRe;
        re[b] = at(re, a) - tRe;
        im[b] = at(im, a) - tIm;
        re[a] = at(re, a) + tRe;
        im[a] = at(im, a) + tIm;
        const next = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = next;
      }
    }
  }
}

/** Largest power of two no longer than `n`. */
const powerOfTwo = (n: number): number => 2 ** Math.floor(Math.log2(n));

/**
 * The features of `samples` (-1..1) taken at `sampleRate`, over the speech band `band`. Only the
 * first power-of-two run of samples goes through the spectrum.
 */
export function voiceFeatures(
  samples: ArrayLike<number>,
  sampleRate: number,
  band: VoiceDetectorConfig["band"],
): VoiceFeatures {
  const length = samples.length;
  if (length < 2)
    return { rms: 0, bandShare: 0, flatness: 1, zeroCrossings: 0 };
  let sum = 0;
  let crossings = 0;
  for (let i = 0; i < length; i++) {
    const sample = at(samples, i);
    sum += sample * sample;
    if (i > 0 && sample >= 0 !== at(samples, i - 1) >= 0) crossings++;
  }
  const rms = Math.sqrt(sum / length);
  const zeroCrossings = crossings / (length - 1);

  const n = powerOfTwo(length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++)
    re[i] =
      at(samples, i) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  fft(re, im);
  const binHz = sampleRate / n;
  const low = Math.max(1, Math.ceil(band.low / binHz));
  const high = Math.min(n / 2 - 1, Math.floor(band.high / binHz));
  let total = 0;
  let inBand = 0;
  let logSum = 0;
  let bins = 0;
  for (let k = 1; k < n / 2; k++) {
    const power = at(re, k) * at(re, k) + at(im, k) * at(im, k);
    total += power;
    if (k < low || k > high) continue;
    inBand += power;
    logSum += Math.log(power + 1e-20);
    bins++;
  }
  if (total === 0 || bins === 0)
    return { rms, bandShare: 0, flatness: 1, zeroCrossings };
  const flatness = inBand === 0 ? 1 : Math.exp(logSum / bins) / (inBand / bins);
  return { rms, bandShare: inBand / total, flatness, zeroCrossings };
}

/** Whether a frame with `features` looks like speech. */
export function looksLikeVoice(
  features: VoiceFeatures,
  config: VoiceDetectorConfig,
): boolean {
  return (
    rmsLevel(features.rms) >= config.minLevel &&
    features.bandShare >= config.minBandShare &&
    features.flatness <= config.maxFlatness &&
    features.zeroCrossings <= config.maxZeroCrossings
  );
}

/** Where the detector stands: when the current run of speech-like frames began, and last was. */
interface VoiceDetectorState {
  readonly runSince: number | null;
  readonly lastAt: number | null;
  readonly speaking: boolean;
}

const QUIET: VoiceDetectorState = {
  runSince: null,
  lastAt: null,
  speaking: false,
};

/**
 * The detector after a frame at `now`, in seconds, that `looked` like speech or not. Speech
 * starts once frames have looked like it for the onset, unbroken for longer than the hangover,
 * and ends once none has for the hangover.
 */
function nextVoice(
  state: VoiceDetectorState,
  looked: boolean,
  now: number,
  config: VoiceDetectorConfig,
): VoiceDetectorState {
  const broken =
    state.lastAt === null || now - state.lastAt > config.hangoverSeconds;
  if (!looked) {
    if (broken) return QUIET;
    return state;
  }
  const runSince = broken || state.runSince === null ? now : state.runSince;
  const speaking =
    (state.speaking && !broken) || now - runSince >= config.onsetSeconds;
  return { runSince, lastAt: now, speaking };
}

/** Whether the detector in `state` hears speech at `now`. */
const hearsVoice = (
  state: VoiceDetectorState,
  now: number,
  config: VoiceDetectorConfig,
): boolean =>
  state.speaking &&
  state.lastAt !== null &&
  now - state.lastAt <= config.hangoverSeconds;

/** A detector fed frames as they come: `hear` takes one and says whether speech is heard. */
export function createVoiceDetector(config: VoiceDetectorConfig) {
  let state = QUIET;
  return {
    hear(samples: ArrayLike<number>, sampleRate: number, now: number): boolean {
      const looked = looksLikeVoice(
        voiceFeatures(samples, sampleRate, config.band),
        config,
      );
      state = nextVoice(state, looked, now, config);
      return hearsVoice(state, now, config);
    },
    /** Forgets what was heard, as when the mic goes off. */
    reset(): void {
      state = QUIET;
    },
  };
}
