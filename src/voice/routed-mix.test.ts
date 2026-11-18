import { describe, expect, test } from "vitest";
import { interferenceAt, routedMix, voiceMix } from "./voice-proximity.js";

const air = { full: 100, silent: 600, pan: 300 };
const falloff = { ...air, radio: { full: 50, silent: 400, pan: 300 } };
const listener = { x: 0, y: 0 };

describe("routedMix", () => {
  test("through the air alone, it is the proximity mix, with no radio part", () => {
    const at = { x: 350, y: 0 };
    expect(routedMix(listener, [{ at, via: "air" }], falloff)).toEqual(
      voiceMix(listener, at, falloff),
    );
  });

  test("with no route at all, it is silent", () => {
    expect(routedMix(listener, [], falloff)).toEqual({ volume: 0, pan: 0 });
  });

  test("of several routes each way, the loudest is heard, a radio one by the radio falloff", () => {
    const mix = routedMix(
      listener,
      [
        { at: { x: 700, y: 0 }, via: "air" },
        { at: { x: -300, y: 0 }, via: "radio" },
        { at: { x: 1000, y: 0 }, via: "radio" },
        { at: { x: 0, y: 1000 }, via: "radio" },
      ],
      falloff,
    );
    expect(mix.volume).toBe(0);
    expect(mix.radio?.volume).toBeCloseTo(1 - 250 / 350);
    expect(mix.radio?.pan).toBe(-1);
  });

  test("a radio route falls off as the air does when no radio falloff is given", () => {
    const at = { x: 350, y: 0 };
    expect(routedMix(listener, [{ at, via: "radio" }], air).radio).toEqual({
      ...voiceMix(listener, at, air),
      interference: 0,
    });
  });

  test("a route from no place is heard in full, centred", () => {
    expect(
      routedMix(listener, [{ at: null, via: "radio" }], falloff).radio,
    ).toEqual({ volume: 1, pan: 0, interference: 0 });
  });
});

describe("interference on a voice carried by radio", () => {
  const curve = { clear: 100, lost: 1100, floor: 0.1, ceiling: 1 };

  test("tops out at its ceiling from lost, however far", () => {
    const capped = { ...curve, ceiling: 0.4 };
    expect(interferenceAt(600, capped)).toBeCloseTo(0.25);
    expect(interferenceAt(1100, capped)).toBe(0.4);
    expect(interferenceAt(1_000_000, capped)).toBe(0.4);
  });

  test("is its floor up to clear, its ceiling from lost, and rises smoothly between", () => {
    expect(interferenceAt(0, curve)).toBe(0.1);
    expect(interferenceAt(100, curve)).toBe(0.1);
    expect(interferenceAt(600, curve)).toBeCloseTo(0.55);
    expect(interferenceAt(1100, curve)).toBe(1);
    expect(interferenceAt(5000, curve)).toBe(1);
    let last = 0;
    for (let d = 0; d <= 1200; d += 50) {
      const now = interferenceAt(d, curve);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  test("grows with how far the voice was carried, not how far the listener is from the speaker", () => {
    const at = { x: 50, y: 0 };
    const mix = (from: { x: number; y: number }) =>
      routedMix(listener, [{ at, via: "radio", from }], {
        ...falloff,
        interference: curve,
      }).radio;
    expect(mix({ x: 50, y: 50 })?.interference).toBe(0.1);
    expect(mix({ x: 50, y: 2000 })?.interference).toBe(1);
    expect(mix({ x: 50, y: 2000 })?.volume).toBe(mix({ x: 50, y: 50 })?.volume);
  });

  test("is the loudest radio route\x27s", () => {
    const mix = routedMix(
      listener,
      [
        { at: { x: 300, y: 0 }, via: "radio", from: { x: 300, y: 0 } },
        { at: { x: 0, y: 0 }, via: "radio", from: { x: 0, y: 1100 } },
      ],
      { ...falloff, interference: curve },
    );
    expect(mix.radio).toMatchObject({ volume: 1, interference: 1 });
  });

  test("is the floor for a route that does not say where it was carried from", () => {
    const mix = routedMix(listener, [{ at: { x: 0, y: 0 }, via: "radio" }], {
      ...falloff,
      interference: curve,
    });
    expect(mix.radio?.interference).toBe(0.1);
  });
});
