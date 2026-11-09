import { describe, expect, it } from "vitest";
import { voiceMix } from "./voice-proximity.js";

const falloff = { full: 100, silent: 600, pan: 300 };
const listener = { x: 1000, y: 1000 };
const at = (dx: number, dy = 0) => ({ x: listener.x + dx, y: listener.y + dy });
const mix = (speaker: { x: number; y: number }) =>
  voiceMix(listener, speaker, falloff);

describe("voiceMix", () => {
  it("is full volume close by", () => {
    expect(mix(listener).volume).toBe(1);
    expect(mix(at(0, falloff.full)).volume).toBe(1);
  });

  it("is silent far away", () => {
    expect(mix(at(0, falloff.silent)).volume).toBe(0);
    expect(mix(at(0, falloff.silent * 3)).volume).toBe(0);
  });

  it("falls off monotonically between", () => {
    const volumes = [100, 200, 300, 400, 500, 600].map(
      (d) => mix(at(0, d)).volume,
    );
    for (let i = 1; i < volumes.length; i++) {
      expect(volumes[i]).toBeLessThan(volumes[i - 1] ?? Infinity);
    }
    expect(mix(at(0, 350)).volume).toBeCloseTo(0.5);
  });

  it("pans towards the speaker's side", () => {
    expect(mix(at(-100)).pan).toBeLessThan(0);
    expect(mix(at(100)).pan).toBeGreaterThan(0);
    expect(mix(at(0, 200)).pan).toBe(0);
  });

  it("saturates pan at the pan distance", () => {
    expect(mix(at(falloff.pan)).pan).toBe(1);
    expect(mix(at(-falloff.pan * 2)).pan).toBe(-1);
  });
});
