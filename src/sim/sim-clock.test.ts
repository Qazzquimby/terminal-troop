import { expect, test } from "vitest";
import { FIXED_DT } from "./config.js";
import { createSimClock, planSteps, stepAlpha } from "./sim-clock.js";

const LIMITS = { dtMs: 10, maxCatchUpMs: 1000, maxStepsPerFrame: 20 };

const noStep = (): void => undefined;

test("a normal frame runs the steps that fit and keeps the remainder", () => {
  expect(planSteps(0, 25, LIMITS)).toEqual({ simTime: 0, steps: 2 });
  expect(planSteps(20, 30, LIMITS)).toEqual({ simTime: 20, steps: 1 });
});

test("a gap past the cap drops the excess", () => {
  expect(planSteps(0, 5000, LIMITS).simTime).toBe(4000);
});

test("the per-frame budget leaves a remainder for later frames", () => {
  expect(planSteps(0, 500, LIMITS)).toEqual({ simTime: 0, steps: 20 });
  const clock = createSimClock(LIMITS);
  expect(clock.advance(500, noStep)).toEqual({ steps: 20, alpha: 1 });
  expect(clock.advance(500, noStep).steps).toBe(20);
});

test("a zero or negative gap runs nothing", () => {
  expect(planSteps(100, 100, LIMITS)).toEqual({ simTime: 100, steps: 0 });
  expect(planSteps(100, 50, LIMITS)).toEqual({ simTime: 100, steps: 0 });
});

test("each step gets its own end time", () => {
  const ends: number[] = [];
  createSimClock(LIMITS).advance(35, (until) => ends.push(until));
  expect(ends).toEqual([10, 20, 30]);
});

test("alpha is the leftover fraction of a step, clamped to 0..1", () => {
  expect(stepAlpha(0, FIXED_DT)).toBe(0);
  expect(stepAlpha(FIXED_DT / 2, FIXED_DT)).toBeCloseTo(0.5);
  expect(stepAlpha(FIXED_DT * 2, FIXED_DT)).toBe(1);
  expect(stepAlpha(-1, FIXED_DT)).toBe(0);
});

test("alpha is the remainder past the last step", () => {
  const clock = createSimClock(LIMITS);
  expect(clock.advance(35, noStep)).toEqual({ steps: 3, alpha: 0.5 });
  expect(clock.advance(38, noStep).alpha).toBeCloseTo(0.8);
});

test("reset starts the simulation at the given time", () => {
  const clock = createSimClock(LIMITS);
  clock.advance(500, noStep);
  clock.reset(1000);
  const ends: number[] = [];
  expect(clock.advance(1025, (until) => ends.push(until))).toEqual({
    steps: 2,
    alpha: 0.5,
  });
  expect(ends).toEqual([1010, 1020]);
});
