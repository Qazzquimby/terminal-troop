import { expect, test } from "vitest";
import { createSfx } from "../src/engine/audio.js";
import {
  FIXED_DT,
  MAX_CATCH_UP_S,
  MAX_FRAME_S,
  STAMINA_MAX,
} from "../src/engine/config.js";
import { splitFrameTime } from "../src/engine/frame-time.js";
import {
  catchUpSession,
  createSession,
  updateSession,
} from "../src/engine/session.js";

test("a normal frame is all live time", () => {
  expect(splitFrameTime(0.016, 0)).toEqual({ idleSteps: 0, live: 0.016 });
});

test("a visible long frame is clamped and not caught up", () => {
  expect(splitFrameTime(0.5, 0)).toEqual({ idleSteps: 0, live: MAX_FRAME_S });
  expect(splitFrameTime(60, 0)).toEqual({ idleSteps: 0, live: MAX_FRAME_S });
});

test("hidden time becomes idle fixed steps", () => {
  const { idleSteps, live } = splitFrameTime(1.05, 1);
  expect(live).toBe(MAX_FRAME_S);
  expect(idleSteps).toBe(Math.floor(1 / FIXED_DT));
});

test("idle catch-up is capped", () => {
  expect(splitFrameTime(3600, 3600).idleSteps).toBe(
    Math.floor(MAX_CATCH_UP_S / FIXED_DT),
  );
});

test("negative time simulates nothing", () => {
  expect(splitFrameTime(-1, -1)).toEqual({ idleSteps: 0, live: 0 });
});

test("stamina recovers while the page is away and the player stays put", () => {
  const game = createSession("me", "ME", "AWAY1", "standard", createSfx());
  const sprint = {
    move: { x: 1, y: 0 },
    aim: { x: 0, y: 0 },
    sprint: true,
  };
  for (let i = 0; i < Math.round(3.5 / FIXED_DT); i++) {
    updateSession(game, sprint, FIXED_DT, 0);
  }
  expect(game.local.stamina.value).toBe(0);
  expect(game.local.stamina.exhausted).toBe(true);
  const aim = game.local.aim;

  // Page hidden for 6s: the first frame back sees 6s elapsed.
  catchUpSession(game, splitFrameTime(6, 6).idleSteps, 0);

  expect(game.local.stamina.value).toBe(STAMINA_MAX);
  expect(game.local.stamina.exhausted).toBe(false);
  expect(game.local.vx).toBeCloseTo(0);
  expect(game.local.vy).toBeCloseTo(0);
  expect(game.local.aim).toBeCloseTo(aim);
  const { x, y } = game.local;
  catchUpSession(game, 60, 0);
  expect(game.local).toMatchObject({ x, y });
});
