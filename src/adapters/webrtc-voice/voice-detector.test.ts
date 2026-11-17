import { describe, expect, test } from "vitest";
import { VOICE_DETECTOR } from "./voice-detector.fixture.js";
import {
  createVoiceDetector,
  looksLikeVoice,
  voiceFeatures,
} from "./voice-detector.js";

const RATE = 48_000;
const FRAME = 2048;
/** Seconds between frames, as a mic polled every frame of a 50fps game would see them. */
const STEP = 0.02;
const CONFIG = VOICE_DETECTOR;

/** A seeded random in -1..1, so noise is the same each run. */
function noiseSource(seed = 1): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (state / 2_147_483_648) * 2 - 1;
  };
}

/**
 * A voice-like sound at time `t`: a 160 Hz buzz with harmonics shaped toward the speech band,
 * swelling and fading four times a second as syllables do.
 */
function syllables(t: number): number {
  const envelope = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * t);
  let sample = 0;
  for (let harmonic = 1; harmonic <= 12; harmonic++) {
    const hz = 160 * harmonic;
    const weight = hz >= 300 && hz <= 1500 ? 1 : 0.25;
    sample += weight * Math.sin(2 * Math.PI * hz * t);
  }
  return 0.08 * envelope * sample;
}

const random = noiseSource();
const whiteNoise = (): number => 0.3 * random();

/** A key's clack: a 5 ms burst of noise every 150 ms, silent between. */
const clicks = (): ((t: number) => number) => {
  const next = noiseSource(7);
  return (t) => (t % 0.15 < 0.005 ? 0.9 * next() : 0);
};

/** The frame of `signal` ending at `t`. */
function frameAt(signal: (t: number) => number, t: number): Float32Array {
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) frame[i] = signal(t - (FRAME - i) / RATE);
  return frame;
}

/** Runs a detector over `seconds` of `signal`, saying at each step whether it heard speech. */
function hear(signal: (t: number) => number, seconds: number): boolean[] {
  const detector = createVoiceDetector(CONFIG);
  const heard: boolean[] = [];
  for (let t = 1; t < 1 + seconds; t += STEP)
    heard.push(detector.hear(frameAt(signal, t), RATE, t));
  return heard;
}

const share = (heard: readonly boolean[]): number =>
  heard.filter(Boolean).length / heard.length;

describe("frames", () => {
  test("a tone in the speech band looks like speech", () => {
    const tone = frameAt((t) => 0.2 * Math.sin(2 * Math.PI * 600 * t), 1);
    const features = voiceFeatures(tone, RATE, CONFIG.band);
    expect(features.bandShare).toBeGreaterThan(0.9);
    expect(features.flatness).toBeLessThan(0.05);
    expect(looksLikeVoice(features, CONFIG)).toBe(true);
  });

  test("white noise does not: it is flat, spread past the band, and crosses zero too often", () => {
    const features = voiceFeatures(frameAt(whiteNoise, 1), RATE, CONFIG.band);
    expect(features.flatness).toBeGreaterThan(CONFIG.maxFlatness);
    expect(features.bandShare).toBeLessThan(CONFIG.minBandShare);
    expect(features.zeroCrossings).toBeGreaterThan(CONFIG.maxZeroCrossings);
    expect(looksLikeVoice(features, CONFIG)).toBe(false);
  });

  test("a mains hum under the band does not", () => {
    const hum = frameAt((t) => 0.3 * Math.sin(2 * Math.PI * 50 * t), 1);
    expect(looksLikeVoice(voiceFeatures(hum, RATE, CONFIG.band), CONFIG)).toBe(
      false,
    );
  });

  test("silence and a whisper under the floor do not", () => {
    expect(
      looksLikeVoice(
        voiceFeatures(new Float32Array(FRAME), RATE, CONFIG.band),
        CONFIG,
      ),
    ).toBe(false);
    const faint = frameAt((t) => 0.0005 * Math.sin(2 * Math.PI * 600 * t), 1);
    expect(
      looksLikeVoice(voiceFeatures(faint, RATE, CONFIG.band), CONFIG),
    ).toBe(false);
  });
});

describe("hearing speech over time", () => {
  test("syllables are heard, unbroken through the dips between them", () => {
    const heard = hear(syllables, 2);
    const start = heard.indexOf(true);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start * STEP).toBeLessThan(0.4);
    expect(heard.slice(start).every(Boolean)).toBe(true);
  });

  test("white noise is never heard", () => {
    expect(share(hear(whiteNoise, 2))).toBe(0);
  });

  test("typing is never heard", () => {
    expect(share(hear(clicks(), 2))).toBe(0);
  });

  test("speech is heard a little past its end, then not", () => {
    const detector = createVoiceDetector(CONFIG);
    let t = 1;
    for (; t < 2; t += STEP) detector.hear(frameAt(syllables, t), RATE, t);
    const silence = new Float32Array(FRAME);
    const stopped = t;
    const heard: number[] = [];
    for (; t < 3; t += STEP)
      if (detector.hear(silence, RATE, t)) heard.push(t - stopped);
    expect(heard.length).toBeGreaterThan(0);
    expect(Math.max(...heard)).toBeLessThanOrEqual(
      CONFIG.hangoverSeconds + STEP,
    );
  });

  test("a single click is too short to start speech, even one that looks like it", () => {
    const blip = (t: number): number =>
      t >= 1 && t < 1.01 ? 0.3 * Math.sin(2 * Math.PI * 600 * t) : 0;
    expect(share(hear(blip, 1))).toBe(0);
  });
});
