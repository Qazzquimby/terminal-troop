import { expect, test } from "vitest";
import type { Action } from "../src/engine/actions.js";
import { createActionState, toControls } from "../src/engine/actions.js";
import { createSfx } from "../src/engine/audio.js";
import {
  FIXED_DT,
  PLAYER_ACCELERATION,
  PLAYER_SPEED,
  STAMINA_MAX,
} from "../src/engine/config.js";
import type { Session } from "../src/engine/session.js";
import { createSession, updateSession } from "../src/engine/session.js";
import { STEP_LIMITS, advanceSim, planSteps } from "../src/engine/sim-clock.js";

const DT = STEP_LIMITS.dtMs;
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

type ActionState = ReturnType<typeof createActionState>;

function openFloor(): Session {
  const game = createSession("me", "ME", "CLOCK", "dev", createSfx());
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  return game;
}

/** Runs frames at `target` until the simulation has caught up; returns the new sim time. */
function catchUp(
  game: Session,
  state: ActionState,
  simTime: number,
  target: number,
): number {
  let time = simTime;
  for (;;) {
    const { simTime: next, steps } = advanceSim(time, target, (until) => {
      const controls = toControls(state.consume(until), { x: 0, y: 0 });
      updateSession(game, controls, FIXED_DT, until);
    });
    time = next;
    if (steps === 0) return time;
  }
}

function hold(action: Action, from: number, to: number): ActionState {
  const state = createActionState();
  state.press(action, from);
  state.release(action, to);
  return state;
}

test("input held between frames moves the player as if frames had run", () => {
  // Held for 1s; the times sit between step ends, as real key events do.
  const caughtUp = openFloor();
  catchUp(caughtUp, hold("moveRight", 5, 1005), 0, 1400);

  const stepped = openFloor();
  const state = hold("moveRight", 5, 1005);
  let simTime = 0;
  for (let target = 16; target <= 1400; target += 16) {
    simTime = catchUp(stepped, state, simTime, target);
  }

  // Walk speed for 1s: the distance lost speeding up is about what braking adds.
  expect(Math.abs(caughtUp.local.x - 100 - PLAYER_SPEED)).toBeLessThan(10);
  expect(caughtUp.local.x).toBeCloseTo(stepped.local.x, 1);
});

test("stamina refills over blurred time and the player does not walk on", () => {
  const game = openFloor();
  const state = createActionState();
  state.press("sprint", 0);
  state.press("moveRight", 0);
  state.release("moveRight", 1000);
  state.press("moveLeft", 1000);
  state.release("moveLeft", 2000);
  state.press("moveRight", 2000);
  let simTime = catchUp(game, state, 0, 3500);
  expect(game.local.stamina.value).toBe(0);

  state.clear(3500);
  const atBlur = { x: game.local.x, y: game.local.y };
  simTime = catchUp(game, state, simTime, 9500);

  expect(game.local.stamina.value).toBe(STAMINA_MAX);
  expect(game.local.stamina.exhausted).toBe(false);
  expect({ vx: game.local.vx, vy: game.local.vy }).toEqual({ vx: 0, vy: 0 });
  // Only the braking from walk speed after the blur.
  const braking = PLAYER_SPEED ** 2 / (2 * PLAYER_ACCELERATION);
  expect(Math.abs(game.local.x - atBlur.x)).toBeLessThanOrEqual(braking + 1);
  expect(game.local.y).toBe(atBlur.y);
  expect(9500 - simTime).toBeLessThan(DT);
});

test("a tap inside one step is seen once", () => {
  const state = createActionState();
  state.press("sprint", DT * 3 + 2);
  state.release("sprint", DT * 3 + 5);
  const seen: string[] = [];
  advanceSim(0, DT * 10, (until) => {
    const frame = state.consume(until);
    if (frame.pressed.has("sprint")) seen.push(`pressed ${String(until)}`);
    if (frame.released.has("sprint")) seen.push(`released ${String(until)}`);
  });
  expect(seen).toEqual([
    `pressed ${String(DT * 4)}`,
    `released ${String(DT * 4)}`,
  ]);
});
