import { describe, expect, test, vi } from "vitest";
import type { Sfx } from "../../audio/index.js";
import type { VoiceParams } from "../../sim/index.js";
import { createSpeechSynth } from "./index.js";
import { segmentsOf, synthesize } from "./synth.js";

const RATE = 22_050;

const PLAIN: VoiceParams = {
  pitch: 140,
  intonation: 0,
  rate: 12,
  formant: 1,
  roughness: 0,
  breathiness: 0,
  ring: 0,
  volume: 0.8,
  range: 250,
};

/** The pitch, in Hz, `samples` repeat at most strongly between 60 and 500Hz. */
function pitchOf(samples: Float32Array): number {
  // The middle of the line, clear of its edges.
  const from = Math.floor(samples.length / 3);
  const span = Math.floor(samples.length / 3);
  let best = 0;
  let bestLag = 1;
  for (let lag = Math.floor(RATE / 500); lag <= RATE / 60; lag += 1) {
    let sum = 0;
    for (let i = from; i < from + span; i += 1)
      sum += (samples[i] ?? 0) * (samples[i + lag] ?? 0);
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return RATE / bestLag;
}

/** How often, a second, `samples` cross zero: higher for brighter sound. */
function crossings(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i += 1)
    if ((samples[i - 1] ?? 0) < 0 !== (samples[i] ?? 0) < 0) count += 1;
  return (count / samples.length) * RATE;
}

const peakOf = (samples: Float32Array): number =>
  Math.max(...Array.from(samples, Math.abs));

describe("a line", () => {
  test("with nothing to say is silent", () => {
    expect(synthesize("", PLAIN, RATE)).toHaveLength(0);
    expect(synthesize(" ...  ", PLAIN, RATE)).toHaveLength(0);
  });

  test("is the same each time, finite, and peaks at 0.9", () => {
    const once = synthesize("Happy birthday to me!", PLAIN, RATE);
    expect(synthesize("Happy birthday to me!", PLAIN, RATE)).toEqual(once);
    expect(once.every(Number.isFinite)).toBe(true);
    expect(peakOf(once)).toBeCloseTo(0.9, 5);
  });

  test("takes about a letter's time a letter, at the voice's rate", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const seconds = (rate: number) =>
      synthesize(text, { ...PLAIN, rate }, RATE).length / RATE;
    expect(seconds(12)).toBeGreaterThan((text.length / 12) * 0.7);
    expect(seconds(12)).toBeLessThan((text.length / 12) * 1.3);
    expect(seconds(6)).toBeCloseTo(seconds(12) * 2, 1);
  });

  test("pauses longer at a full stop than between words", () => {
    const pauses = segmentsOf("a b. c")
      .filter((segment) => segment.voiced === 0 && segment.hiss === 0)
      .map((segment) => segment.length);
    expect(pauses).toHaveLength(3);
    expect(pauses[1]).toBeGreaterThan(pauses[0] ?? Infinity);
  });
});

describe("a voice", () => {
  test("hums at its pitch", () => {
    for (const pitch of [110, 220]) {
      const heard = pitchOf(synthesize("aaaaaaaa", { ...PLAIN, pitch }, RATE));
      expect(heard).toBeGreaterThan(pitch * 0.93);
      expect(heard).toBeLessThan(pitch * 1.07);
    }
  });

  test("with a smaller throat sounds brighter", () => {
    const text = "hello how are you";
    const grown = crossings(synthesize(text, PLAIN, RATE));
    const small = crossings(synthesize(text, { ...PLAIN, formant: 1.4 }, RATE));
    expect(small).toBeGreaterThan(grown * 1.15);
  });

  test("whispering, has no pitch to it; rough, wavers from period to period", () => {
    const text = "aaaaaaaa";
    const clean = synthesize(text, PLAIN, RATE);
    const whisper = synthesize(text, { ...PLAIN, breathiness: 1 }, RATE);
    const rough = synthesize(text, { ...PLAIN, roughness: 1 }, RATE);
    expect(rough).not.toEqual(clean);
    // A whisper is hiss: it crosses zero far more often than a hum.
    expect(crossings(whisper)).toBeGreaterThan(crossings(clean) * 2);
  });

  test("with a ring modulator sounds otherwise than without", () => {
    const text = "I am a robot";
    expect(synthesize(text, { ...PLAIN, ring: 50 }, RATE)).not.toEqual(
      synthesize(text, PLAIN, RATE),
    );
  });
});

test("speech plays through the sound effects from where its speaker stands, at its voice's volume and range", async () => {
  const handle = {
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  };
  const playSamples = vi.fn<Sfx["playSamples"]>(() => Promise.resolve(handle));
  const speech = createSpeechSynth({ playSamples }, RATE);
  const at = { x: 10, y: 20 };
  const listener = { x: 0, y: 0 };
  expect(await speech.say({ text: "Hi.", voice: PLAIN, at, listener })).toBe(
    handle,
  );
  const [samples, rate, from, to, options] = playSamples.mock.calls[0] ?? [];
  expect(samples).toEqual(synthesize("Hi.", PLAIN, RATE));
  expect({ rate, from, to, options }).toEqual({
    rate: RATE,
    from: at,
    to: listener,
    options: { volume: PLAIN.volume, range: PLAIN.range },
  });
});
