import { expect, test } from "vitest";
import { advanceSim, planSteps } from "./sim-clock.js";

const LIMITS = { dtMs: 10, maxCatchUpMs: 1000, maxStepsPerFrame: 20 };

test("a normal frame runs the steps that fit and keeps the remainder", () => {
  expect(planSteps(0, 25, LIMITS)).toEqual({ simTime: 0, steps: 2 });
  expect(planSteps(20, 30, LIMITS)).toEqual({ simTime: 20, steps: 1 });
});

test("a gap past the cap drops the excess", () => {
  expect(planSteps(0, 5000, LIMITS).simTime).toBe(4000);
});

test("the per-frame budget leaves a remainder for later frames", () => {
  expect(planSteps(0, 500, LIMITS)).toEqual({ simTime: 0, steps: 20 });
  expect(advanceSim(0, 500, () => undefined, LIMITS)).toEqual({
    simTime: 200,
    steps: 20,
  });
});

test("a zero or negative gap runs nothing", () => {
  expect(planSteps(100, 100, LIMITS)).toEqual({ simTime: 100, steps: 0 });
  expect(planSteps(100, 50, LIMITS)).toEqual({ simTime: 100, steps: 0 });
});

test("each step gets its own end time", () => {
  const ends: number[] = [];
  advanceSim(0, 35, (until) => ends.push(until), LIMITS);
  expect(ends).toEqual([10, 20, 30]);
});
