import { expect, test } from "vitest";
import {
  STAMINA_DRAIN,
  STAMINA_MAX,
  STAMINA_RECOVER,
  STAMINA_REGEN,
  STAMINA_REGEN_DELAY,
} from "./config.js";
import type { Stamina } from "./stamina.js";
import { canSprint, createStamina, updateStamina } from "./stamina.js";

const STEP = 1 / 60;

function step(stamina: Stamina, sprinting: boolean, seconds: number): Stamina {
  let current = stamina;
  for (let i = 0; i < Math.round(seconds / STEP); i++) {
    current = updateStamina(current, sprinting, STEP);
  }
  return current;
}

test("sprinting drains at the configured rate", () => {
  const stamina = step(createStamina(), true, 1);
  expect(stamina.value).toBeCloseTo(STAMINA_MAX - STAMINA_DRAIN);
});

test("a full bar lasts about three seconds", () => {
  expect(step(createStamina(), true, 2.9).value).toBeGreaterThan(0);
  expect(step(createStamina(), true, 3.1).value).toBe(0);
});

test("regeneration waits for the delay, then refills", () => {
  const drained = step(createStamina(), true, 1);
  const waiting = step(drained, false, STAMINA_REGEN_DELAY - 0.1);
  expect(waiting.value).toBe(drained.value);

  const regenerating = step(waiting, false, 1.1);
  expect(regenerating.value).toBeCloseTo(drained.value + STAMINA_REGEN, 0);

  expect(step(regenerating, false, 10).value).toBe(STAMINA_MAX);
});

test("sprinting again resets the regeneration delay", () => {
  const rested = step(step(createStamina(), true, 1), false, 2);
  const resprint = step(rested, true, STEP);
  expect(step(resprint, false, STAMINA_REGEN_DELAY - 0.1).value).toBe(
    resprint.value,
  );
});

test("hitting 0 blocks sprint until the recovery threshold", () => {
  const empty = step(createStamina(), true, 4);
  expect(empty.value).toBe(0);
  expect(empty.exhausted).toBe(true);
  expect(canSprint(empty)).toBe(false);

  let current = empty;
  while (current.value < STAMINA_RECOVER) {
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
    expect(current.value).toBeLessThanOrEqual(STAMINA_MAX);
  }
});
