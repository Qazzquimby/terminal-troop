import { expect, test } from "vitest";
import type { Stamina, StaminaConfig } from "./stamina.js";
import {
  canSprint,
  createStamina as createFrom,
  spendStamina,
  updateStamina as updateWith,
} from "./stamina.js";

const STEP = 1 / 60;

/** A full bar lasts 3s of sprinting and refills in 4s after a 0.6s rest. */
const config: StaminaConfig = {
  max: 100,
  drain: 100 / 3,
  regen: 25,
  regenDelay: 0.6,
  recover: 30,
};
const createStamina = () => createFrom(config);
const updateStamina = (stamina: Stamina, sprinting: boolean, dt: number) =>
  updateWith(stamina, sprinting, dt, config);

function step(stamina: Stamina, sprinting: boolean, seconds: number): Stamina {
  let current = stamina;
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    current = updateStamina(current, sprinting, STEP);
  }
  return current;
}

test("sprinting drains at the configured rate", () => {
  const stamina = step(createStamina(), true, 1);
  expect(stamina.value).toBeCloseTo(config.max - config.drain);
});

test("a full bar lasts about three seconds", () => {
  expect(step(createStamina(), true, 2.9).value).toBeGreaterThan(0);
  expect(step(createStamina(), true, 3.1).value).toBe(0);
});

test("regeneration waits for the delay, then refills", () => {
  const drained = step(createStamina(), true, 1);
  const waiting = step(drained, false, config.regenDelay - 0.1);
  expect(waiting.value).toBe(drained.value);

  const regenerating = step(waiting, false, 1.1);
  expect(regenerating.value).toBeCloseTo(drained.value + config.regen, 0);

  expect(step(regenerating, false, 10).value).toBe(config.max);
});

test("sprinting again resets the regeneration delay", () => {
  const rested = step(step(createStamina(), true, 1), false, 2);
  const resprint = step(rested, true, STEP);
  expect(step(resprint, false, config.regenDelay - 0.1).value).toBe(
    resprint.value,
  );
});

test("hitting 0 blocks sprint until the recovery threshold", () => {
  const empty = step(createStamina(), true, 4);
  expect(empty.value).toBe(0);
  expect(empty.exhausted).toBe(true);
  expect(canSprint(empty)).toBe(false);

  let current = empty;
  while (current.value < config.recover) {
    expect(canSprint(current)).toBe(false);
    current = updateStamina(current, false, STEP);
  }
  expect(current.exhausted).toBe(false);
  expect(canSprint(current)).toBe(true);
});

test("stamina never leaves [0, max]", () => {
  let current = createStamina();
  for (let i = 0; i < 2000; i++) {
    current = updateStamina(current, i % 400 < 250, STEP * (1 + (i % 7)));
    expect(current.value).toBeGreaterThanOrEqual(0);
    expect(current.value).toBeLessThanOrEqual(config.max);
  }
});

test("spending takes the amount at once and restarts the wait to regenerate", () => {
  const spent = spendStamina(createStamina(), 15);
  expect(spent).toEqual({ value: 85, exhausted: false, rested: 0 });
  if (spent === null) return;
  expect(step(spent, false, 0.5).value).toBe(85);
  expect(step(spent, false, 1).value).toBeGreaterThan(85);
});

test("spending more than there is spends nothing", () => {
  const low = { value: 10, exhausted: false, rested: 0.6 };
  expect(spendStamina(low, 15)).toBeNull();
});

test("spending the last of it exhausts", () => {
  const spent = spendStamina({ value: 15, exhausted: false, rested: 0 }, 15);
  expect(spent).toEqual({ value: 0, exhausted: true, rested: 0 });
});
