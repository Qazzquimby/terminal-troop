import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RADIO_SOUND } from "./radio-sound.fixture.js";
import { crunchCurve, radioNodes, radioTone, rollGlitches } from "./radio.js";
import type { RadioLevels } from "./radio.js";

const RADIO = RADIO_SOUND;

describe("the tone of a voice through a speaker", () => {
  test("is the clean config at no interference and the worst at all of it", () => {
    expect(radioTone(0, RADIO)).toEqual({
      drive: RADIO.crunch.clean,
      hiss: RADIO.hiss.clean,
      dropouts: RADIO.dropout.clean,
      crackles: RADIO.crackle.clean,
    });
    expect(radioTone(1, RADIO)).toEqual({
      drive: RADIO.crunch.worst,
      hiss: RADIO.hiss.worst,
      dropouts: RADIO.dropout.worst,
      crackles: RADIO.crackle.worst,
    });
  });

  test("gets worse in every way as interference grows, and holds past either end", () => {
    const [low, mid, high] = [0.2, 0.5, 0.8].map((i) => radioTone(i, RADIO));
    for (const key of ["drive", "hiss", "dropouts", "crackles"] as const) {
      expect(mid?.[key]).toBeGreaterThan(low?.[key] ?? Infinity);
      expect(high?.[key]).toBeGreaterThan(mid?.[key] ?? Infinity);
    }
    expect(radioTone(-1, RADIO)).toEqual(radioTone(0, RADIO));
    expect(radioTone(2, RADIO)).toEqual(radioTone(1, RADIO));
  });

  test("drops out rarely until interference is high", () => {
    const half = radioTone(0.5, RADIO).dropouts;
    expect(half).toBeLessThan((RADIO.dropout.clean + RADIO.dropout.worst) / 2);
  });
});

describe("glitches", () => {
  /** Counts each kind rolled over `seconds` of 60 fps transmission at `interference`. */
  function count(interference: number, seconds: number) {
    let seed = 1;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const tone = radioTone(interference, RADIO);
    const counts = { dropout: 0, crackle: 0 };
    for (let i = 0; i < seconds * 60; i++)
      for (const glitch of rollGlitches(random, tone, 1 / 60, RADIO)) {
        counts[glitch.kind] += 1;
        const { length } =
          glitch.kind === "dropout" ? RADIO.dropout : RADIO.crackle;
        expect(glitch.length).toBeGreaterThanOrEqual(length.min);
        expect(glitch.length).toBeLessThanOrEqual(length.max);
      }
    return counts;
  }

  test("come about as often as their rates say", () => {
    const worst = count(1, 200);
    expect(worst.dropout / 200).toBeCloseTo(RADIO.dropout.worst, 0);
    expect(worst.crackle / 200).toBeGreaterThan(RADIO.crackle.worst * 0.8);
    expect(worst.crackle / 200).toBeLessThan(RADIO.crackle.worst * 1.2);
  });

  test("are far rarer between walkies close together", () => {
    const near = count(0.1, 200);
    const far = count(1, 200);
    expect(near.dropout * 10).toBeLessThan(far.dropout);
    expect(near.crackle * 3).toBeLessThan(far.crackle);
  });

  test("none come in no time", () => {
    expect(rollGlitches(() => 0, radioTone(1, RADIO), 0, RADIO)).toEqual([]);
  });
});

describe("the crunch curve", () => {
  test("is odd, clips at full scale, and holds only its steps' levels", () => {
    const curve = crunchCurve(8, 257);
    expect(curve[0]).toBe(-1);
    expect(curve[256]).toBe(1);
    expect(curve[128]).toBe(0);
    for (let i = 0; i < 257; i++)
      expect(curve[i]).toBeCloseTo(-(curve[256 - i] ?? 0));
    expect(new Set(curve).size).toBeLessThanOrEqual(9);
  });
});

/** An AudioParam that records the targets set on it. */
function fakeParam() {
  return {
    value: 0,
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function fakeNode() {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: fakeParam(),
    pan: fakeParam(),
    frequency: fakeParam(),
    Q: fakeParam(),
    type: "",
  };
}

type FakeNode = ReturnType<typeof fakeNode>;

/** Every node the fake context made, by kind, in order. */
let made: Record<string, FakeNode[]> = {};
/** Every buffer source the fake context made. */
let sources: { stop: () => void; loop: boolean }[] = [];
/** Every wave shaper the fake context made. */
let shapers: { curve: Float32Array | null }[] = [];

function make<T extends object>(kind: string, extra: T): FakeNode & T {
  const node = { ...fakeNode(), ...extra };
  (made[kind] ??= []).push(node);
  return node;
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate = 100;
  createGain = () => make("gain", {});
  createStereoPanner = () => make("panner", {});
  createBiquadFilter = () => make("filter", {});
  createWaveShaper() {
    const extra: { curve: Float32Array | null } = { curve: null };
    const shaper = make("shaper", extra);
    shapers.push(shaper);
    return shaper;
  }
  createBufferSource() {
    const source = make("source", {
      start: vi.fn(),
      stop: vi.fn(),
      buffer: null,
      loop: false,
    });
    sources.push(source);
    return source;
  }
  createBuffer(_channels: number, length: number) {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  }
}

beforeEach(() => {
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const OFF: RadioLevels = {
  radioGain: 0,
  radioPan: 0,
  radioKeyed: false,
  radioInterference: 0,
};

function speaker(random: () => number = () => 1) {
  const context = new AudioContext();
  const output = context.createGain();
  made = {};
  sources = [];
  shapers = [];
  const nodes = radioNodes(context, output, OFF, RADIO, random);
  // Gains in the order made: drive, makeup, dropout, level, hiss, burst.
  const [drive, , dropout, level, hiss, burst] = made.gain ?? [];
  /** Moves the context's clock to `seconds`. */
  const at = (seconds: number): void => {
    Object.assign(context, { currentTime: seconds });
  };
  return { at, nodes, drive, dropout, level, hiss, burst };
}

const targets = (node: FakeNode | undefined): number[] =>
  node?.gain.setTargetAtTime.mock.calls.map(([value]) => Number(value)) ?? [];

describe("a speaker's nodes", () => {
  test("band the voice and its static to the config, and start the static", () => {
    speaker();
    const frequencies = (made.filter ?? []).map((f) => [
      f.type,
      f.frequency.value,
    ]);
    expect(frequencies).toContainEqual(["highpass", RADIO.band.low]);
    expect(frequencies).toContainEqual(["lowpass", RADIO.band.high]);
    expect(frequencies).toContainEqual(["peaking", RADIO.honk.frequency]);
    expect(shapers[0]?.curve).toBeInstanceOf(Float32Array);
    expect(sources[0]?.loop).toBe(true);
  });

  test("burst with static as a transmission opens and as it closes, at its volume", () => {
    const { at, nodes, burst } = speaker();
    nodes.update({ ...OFF, radioKeyed: true, radioGain: 0.5 }, 0.05);
    expect(targets(burst)).toEqual([0.5 * RADIO.squelch.volume, 0]);
    at(1);
    nodes.update({ ...OFF, radioKeyed: true, radioGain: 0.5 }, 0.05);
    expect(targets(burst)).toHaveLength(2);
    at(2);
    nodes.update(OFF, 0.05);
    expect(targets(burst).slice(2)).toEqual([0.5 * RADIO.squelch.volume, 0]);
  });

  test("hiss and crunch more as interference grows", () => {
    const { at, nodes, drive, hiss } = speaker();
    nodes.update({ ...OFF, radioKeyed: true, radioGain: 1 }, 0.05);
    at(0.1);
    nodes.update(
      { ...OFF, radioKeyed: true, radioGain: 1, radioInterference: 1 },
      0.05,
    );
    expect(targets(hiss).at(-1)).toBe(RADIO.hiss.worst);
    expect(targets(drive).at(-1)).toBe(RADIO.crunch.worst);
  });

  test("drop out, with the static swelling, when a dropout is rolled", () => {
    const { at, nodes, dropout, hiss } = speaker(() => 0);
    nodes.update({ ...OFF, radioKeyed: true, radioGain: 1 }, 0.05);
    at(0.1);
    nodes.update({ ...OFF, radioKeyed: true, radioGain: 1 }, 0.05);
    expect(targets(dropout)).toEqual([RADIO.dropout.depth, 1]);
    expect(targets(hiss)).toEqual([
      RADIO.hiss.clean * RADIO.dropout.swell,
      RADIO.hiss.clean,
    ]);
  });

  test("make no glitches while no transmission plays", () => {
    const { at, nodes, dropout, burst } = speaker(() => 0);
    at(1);
    nodes.update(OFF, 0.05);
    at(2);
    nodes.update(OFF, 0.05);
    expect(targets(dropout)).toEqual([]);
    expect(targets(burst)).toEqual([]);
  });

  test("stop their static on disconnect", () => {
    const { nodes } = speaker();
    nodes.disconnect();
    expect(sources[0]?.stop).toHaveBeenCalled();
  });
});
