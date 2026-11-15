import { range } from "lodash-es";
import { describe, expect, test } from "vitest";
import { inkLeft, inkMask, inkNoise } from "./ink.js";
import type { InkFadeConfig } from "./ink.js";

const fade: InkFadeConfig = { seconds: 10, spread: 0.6, blot: 3, detail: 4 };

describe("inkLeft", () => {
  test("all of it is there when just seen, less as it ages, none once it has lived its life", () => {
    for (const noise of [0, 0.3, 0.999]) {
      const life = fade.seconds * (1 - fade.spread * noise);
      const left = range(0, 101).map((i) =>
        inkLeft((life * i) / 100, noise, fade),
      );
      expect(left[0]).toBe(1);
      for (const [i, value] of left.entries())
        if (i > 0) expect(value).toBeLessThanOrEqual(left[i - 1] ?? 1);
      expect(left.at(-2)).toBeGreaterThan(0);
      expect(left.at(-1)).toBe(0);
    }
  });

  test("it darkens slowly at first, then faster as its time comes", () => {
    const quarter = 1 - inkLeft(fade.seconds / 4, 0, fade);
    const last = inkLeft((fade.seconds * 3) / 4, 0, fade);
    expect(quarter).toBeLessThan(0.1);
    expect(last).toBeLessThan(0.5);
  });

  test("the first spots go `spread` sooner than `seconds`, the last at `seconds`", () => {
    const first = fade.seconds * (1 - fade.spread);
    expect(inkLeft(first - 0.01, 0.999, fade)).toBeGreaterThan(0);
    expect(inkLeft(first + 0.01, 0.999, fade)).toBe(0);
    expect(inkLeft(fade.seconds - 0.01, 0, fade)).toBeGreaterThan(0);
    for (const noise of [0, 0.5, 0.999])
      expect(inkLeft(fade.seconds, noise, fade)).toBe(0);
  });

  test("with `seconds` 0, nothing fades", () => {
    expect(inkLeft(1e6, 0.5, { seconds: 0, spread: 0.6 })).toBe(1);
  });
});

describe("inkNoise", () => {
  const samples = range(0, 40).flatMap((x) =>
    range(0, 40).map((y) => inkNoise(x * 0.37, y * 0.41, fade.blot)),
  );

  test("stays within 0 up to 1, and uses much of that range", () => {
    for (const value of samples) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(Math.min(...samples)).toBeLessThan(0.15);
    expect(Math.max(...samples)).toBeGreaterThan(0.85);
  });

  test("is the same at the same spot, and close at spots close by, so it comes in blots", () => {
    expect(inkNoise(5.2, 7.9, 3)).toBe(inkNoise(5.2, 7.9, 3));
    const steps = range(0, 200).map((i) =>
      Math.abs(inkNoise(i * 0.05, 3, 3) - inkNoise(i * 0.05 + 0.05, 3, 3)),
    );
    expect(Math.max(...steps)).toBeLessThan(0.1);
  });
});

describe("inkMask", () => {
  /** A 4x3 box of cells all `age` seconds old, but for one never seen. */
  const grid = (age: number) => ({
    col: 10,
    row: 20,
    cols: 4,
    rows: 3,
    ages: Float32Array.from(range(12), (i) => (i === 5 ? Infinity : age)),
  });
  const alphas = (age: number) => {
    const { data } = inkMask(grid(age), fade);
    return range(3, data.length, 4).map((i) => data[i] ?? 0);
  };

  test("is `detail` spots to a cell's side", () => {
    const mask = inkMask(grid(0), fade);
    expect(mask.width).toBe(4 * fade.detail);
    expect(mask.height).toBe(3 * fade.detail);
    expect(mask.data).toHaveLength(mask.width * mask.height * 4);
  });

  test("is whole where just seen, empty where never seen", () => {
    const mask = inkMask(grid(0), fade);
    const at = (x: number, y: number) =>
      mask.data[(y * mask.width + x) * 4 + 3];
    expect(at(0, 0)).toBe(255);
    // The cell never seen, at column 1 of row 1.
    expect(at(fade.detail + 1, fade.detail + 1)).toBe(0);
  });

  test("halfway through, some spots are gone and some are left: it goes raggedly, not evenly", () => {
    const left = alphas(fade.seconds * 0.7);
    const gone = left.filter((alpha) => alpha === 0).length;
    expect(gone).toBeGreaterThan(fade.detail ** 2);
    expect(left.filter((alpha) => alpha > 0).length).toBeGreaterThan(0);
    expect(new Set(left).size).toBeGreaterThan(5);
  });

  test("once `seconds` have passed, it is all gone", () => {
    expect(alphas(fade.seconds).every((alpha) => alpha === 0)).toBe(true);
  });
});
