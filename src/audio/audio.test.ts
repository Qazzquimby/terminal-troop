import { describe, expect, test } from "vitest";
import { rangedFalloff, spatialMix } from "./audio.js";

const falloff = { full: 100, silent: 1000, pan: 500 };
const listener = { x: 0, y: 0 };
const volumeAt = (x: number, range?: number): number =>
  spatialMix({ x, y: 0 }, listener, rangedFalloff(falloff, range)).volume;

describe("a sound with a range", () => {
  test("fades to silence at its range, not the falloff's", () => {
    expect(volumeAt(299, 300)).toBeGreaterThan(0);
    expect(volumeAt(300, 300)).toBe(0);
    expect(volumeAt(600, 300)).toBe(0);
    expect(volumeAt(600)).toBeGreaterThan(0);
  });

  test("is full close by, and no further out than half its range", () => {
    expect(volumeAt(50, 1500)).toBe(1);
    expect(volumeAt(100, 1500)).toBe(1);
    expect(volumeAt(150, 1500)).toBeLessThan(1);
    expect(volumeAt(50, 100)).toBe(1);
    expect(volumeAt(60, 100)).toBeLessThan(1);
  });

  test("of nothing is never heard", () => {
    expect(volumeAt(1, 0)).toBe(0);
  });
});
