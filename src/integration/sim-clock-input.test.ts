import { expect, test } from "vitest";
import type { Action } from "../input/index.js";
import { createActionState, toControls } from "../input/index.js";
import type { Session } from "../sim/index.js";
import { createSession, createSimClock, updateSession } from "../sim/index.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const CLOCK = { fixedDt: 1 / 60, maxCatchUpS: 30, maxStepsPerFrame: 240 };
const DT = CLOCK.fixedDt * 1000;
const { player: tuning, stamina } = testSimConfig;

type ActionState = ReturnType<typeof createActionState>;
type SimClock = ReturnType<typeof createSimClock>;

function openFloor(): Session {
  const game = createSession(
    "me",
    "ME",
    "CLOCK",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  return game;
}

/** Runs frames at `target` until the simulation has caught up; returns the final alpha. */
function catchUp(
  game: Session,
  state: ActionState,
  clock: SimClock,
  target: number,
): number {
  for (;;) {
    const { steps, alpha } = clock.advance(target, (until) => {
      const controls = toControls(state.consume(until), { x: 0, y: 0 });
      updateSession(game, controls, clock.dt);
    });
    if (steps === 0) return alpha;
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
  catchUp(caughtUp, hold("moveRight", 5, 1005), createSimClock(CLOCK), 1400);

  const stepped = openFloor();
  const state = hold("moveRight", 5, 1005);
  const clock = createSimClock(CLOCK);
  for (let target = 16; target <= 1400; target += 16) {
    catchUp(stepped, state, clock, target);
  }

  // Walk speed for 1s: the distance lost speeding up is about what braking adds.
  expect(Math.abs(caughtUp.local.x - 100 - tuning.speed)).toBeLessThan(10);
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
  const clock = createSimClock(CLOCK);
  catchUp(game, state, clock, 3500);
  expect(game.local.stamina.value).toBe(0);

  state.clear(3500);
  const atBlur = { x: game.local.x, y: game.local.y };
  const alpha = catchUp(game, state, clock, 9500);

  expect(game.local.stamina.value).toBe(stamina.max);
  expect(game.local.stamina.exhausted).toBe(false);
  expect({ vx: game.local.vx, vy: game.local.vy }).toEqual({ vx: 0, vy: 0 });
  // Only the braking from walk speed after the blur.
  const braking = tuning.speed ** 2 / (2 * tuning.acceleration);
  expect(Math.abs(game.local.x - atBlur.x)).toBeLessThanOrEqual(braking + 1);
  expect(game.local.y).toBe(atBlur.y);
  expect(alpha).toBeLessThan(1);
});

test("a tap inside one step is seen once", () => {
  const state = createActionState();
  state.press("sprint", DT * 3 + 2);
  state.release("sprint", DT * 3 + 5);
  const seen: string[] = [];
  createSimClock(CLOCK).advance(DT * 10, (until) => {
    const frame = state.consume(until);
    if (frame.pressed.has("sprint")) seen.push(`pressed ${String(until)}`);
    if (frame.released.has("sprint")) seen.push(`released ${String(until)}`);
  });
  expect(seen).toEqual([
    `pressed ${String(DT * 4)}`,
    `released ${String(DT * 4)}`,
  ]);
});
