import { expect, test, vi } from "vitest";
import { createItems } from "../items/index.js";
import { createSession, updateSession } from "../sim/index.js";
import type { Controls } from "../sim/index.js";
import { testSfx, testShovelConfig, testSimConfig } from "./sim-config.js";

const DT = 1 / 60;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  select: null,
  use: false,
};
const swing: Controls = { ...idle, use: true };

/** A dev-square session holding the starting shovel, with the test items registered and sound muted. */
function session() {
  const game = createSession(
    "me",
    "ME",
    "ITEMS",
    "dev",
    testSfx(),
    testSimConfig,
  );
  vi.spyOn(game.sfx, "play").mockResolvedValue({
    stop: () => undefined,
    setVolume: () => undefined,
    setPosition: () => undefined,
  });
  createItems({ shovel: testShovelConfig }).register(game);
  return game;
}

/** Steps `game` `seconds` with no input. */
function wait(game: ReturnType<typeof session>, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

test("the select control picks a slot, and null keeps the current one", () => {
  const game = session();
  expect(game.local.held).toBe(0);
  updateSession(game, { ...idle, select: 3 }, DT);
  expect(game.local.held).toBe(3);
  updateSession(game, idle, DT);
  expect(game.local.held).toBe(3);
});

test("the use control swings the held shovel at the step's sim time and queues it for the host", () => {
  const game = session();
  wait(game, 0.5);
  updateSession(game, swing, DT);
  expect(game.local.use).toMatchObject({
    item: "shovel",
    startedAt: game.time,
  });
  expect(game.localUses).toEqual([
    {
      by: "me",
      item: "shovel",
      x: game.local.x,
      y: game.local.y,
      aim: game.local.aim,
    },
  ]);
});

test("a swing waits out the cooldown in sim seconds", () => {
  const game = session();
  updateSession(game, swing, DT);
  const first = game.local.use;
  wait(game, testShovelConfig.cooldown - 2 * DT);
  updateSession(game, swing, DT);
  expect(game.local.use).toBe(first);
  expect(game.localUses).toHaveLength(1);
  wait(game, DT);
  updateSession(game, swing, DT);
  expect(game.local.use).not.toBe(first);
  expect(game.localUses).toHaveLength(2);
});

test("using an empty hand does nothing", () => {
  const game = session();
  updateSession(game, { ...swing, select: 4 }, DT);
  expect(game.local.use).toBeNull();
  expect(game.localUses).toEqual([]);
});
