import { expect, test } from "vitest";
import { beepInterval, signal } from "./index.js";

const config = { range: 1000, behind: 0.25, slowest: 2, fastest: 0.1 };

test("a signal is stronger nearer, and stronger faced than behind", () => {
  const from = { x: 0, y: 0 };
  const near = signal(from, 0, { x: 100, y: 0 }, config);
  const far = signal(from, 0, { x: 800, y: 0 }, config);
  const behind = signal(from, Math.PI, { x: 100, y: 0 }, config);
  expect(near).toBeGreaterThan(far);
  expect(near).toBeGreaterThan(behind);
  expect(behind).toBeGreaterThan(0);
  expect(signal(from, 0, { x: config.range + 1, y: 0 }, config)).toBe(0);
  expect(beepInterval(near, config)).toBeLessThan(beepInterval(far, config));
  expect(beepInterval(1, config)).toBeCloseTo(config.fastest);
  expect(beepInterval(0, config)).toBe(config.slowest);
});
