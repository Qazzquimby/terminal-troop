import { describe, expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import type { Noise } from "./noise.js";
import type { Controls } from "./player.js";
import { applyRemoteState, createSession, updateSession } from "./session.js";
import type { Session } from "./session.js";

const DT = 1 / 60;
const { walk, sprint, crouch } = testSimConfig.footsteps;

const controls = (moving: boolean, sprinting: boolean): Controls => ({
  move: { x: moving ? 1 : 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: sprinting,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
});
const idle = controls(false, false);

/** The dev square, its local player in the open at (100, 300). */
function session(): Session {
  const game = createSession("me", "ME", "STEPS", "dev", testSfx(), {
    ...testSimConfig,
    player: { ...testSimConfig.player, acceleration: 1e6 },
  });
  Object.assign(game.local, { x: 100, y: 300 });
  return game;
}

/** Every noise made over `seconds` of steps under `input`. */
function noisesOver(game: Session, input: Controls, seconds: number): Noise[] {
  const made: Noise[] = [];
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, input, DT);
    made.push(...game.noises);
  }
  return made;
}

describe("the local player's footsteps", () => {
  test("standing still makes none, sprint held or not", () => {
    const game = session();
    expect(noisesOver(game, idle, 2)).toEqual([]);
    expect(noisesOver(game, controls(false, true), 2)).toEqual([]);
  });

  test("walking steps at once, then each walking interval, carrying a walking radius, from where it is", () => {
    const game = session();
    const steps = noisesOver(game, controls(true, false), 2);
    expect(steps).toHaveLength(Math.floor(2 / walk.interval));
    expect(steps.every(({ radius }) => radius === walk.radius)).toBe(true);
    expect(steps[0]).toMatchObject({ source: "me" });
    expect(steps.at(-1)?.at.x).toBeGreaterThan(100);
  });

  test("sprinting steps more often and carry further", () => {
    const game = session();
    const steps = noisesOver(game, controls(true, true), 2);
    expect(steps).toHaveLength(Math.floor(2 / sprint.interval));
    expect(steps.every(({ radius }) => radius === sprint.radius)).toBe(true);
    expect(sprint.radius).toBeGreaterThan(walk.radius);
  });

  test("crouching steps less often and carry less far", () => {
    const game = session();
    updateSession(game, { ...idle, crouch: true }, DT);
    const steps = noisesOver(game, controls(true, false), 2);
    expect(steps).toHaveLength(Math.ceil(2 / crouch.interval));
    expect(steps.every(({ radius }) => radius === crouch.radius)).toBe(true);
    expect(crouch.interval).toBeGreaterThan(walk.interval);
    expect(crouch.radius).toBeLessThan(walk.radius);
  });

  test("stopping ends them, and moving again steps at once", () => {
    const game = session();
    noisesOver(game, controls(true, false), walk.interval / 2);
    expect(noisesOver(game, idle, 1)).toEqual([]);
    updateSession(game, controls(true, false), DT);
    expect(game.noises).toHaveLength(1);
  });
});

describe("a remote player's footsteps", () => {
  const report = (game: Session, content: Record<string, unknown>) =>
    applyRemoteState(game, {
      id: "them",
      name: "THEM",
      x: 700,
      y: 300,
      aim: 0,
      health: 100,
      content,
    });

  test("follow the movement it reports, from where it stands", () => {
    const game = session();
    report(game, { "core/movement": { mode: "sprint", moving: true } });
    const steps = noisesOver(game, idle, 1);
    expect(steps).toHaveLength(Math.floor(1 / sprint.interval));
    expect(steps[0]).toEqual({
      at: { x: 700, y: 300 },
      radius: sprint.radius,
      source: "them",
    });

    report(game, { "core/movement": { mode: "sprint", moving: false } });
    expect(noisesOver(game, idle, 1)).toEqual([]);
  });

  test("a player that reports no movement makes none", () => {
    const game = session();
    report(game, {});
    expect(noisesOver(game, idle, 1)).toEqual([]);
  });
});
