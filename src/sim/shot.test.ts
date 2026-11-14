import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { createSession } from "./session.js";
import { fan, traceShot } from "./shot.js";

/** The dev square, whose pillar fills x 200..300, y 50..150, with a solid dummy and a ghost. */
function session() {
  const game = createSession(
    "me",
    "ME",
    "SHOT",
    "dev",
    testSfx(),
    testSimConfig,
  );
  for (const [kind, collides] of [
    ["dummy", true],
    ["ghost", false],
  ] as const)
    registerEntityType(game, kind, {
      radius: 15,
      maxHealth: 40,
      collides,
      data: z.object({}),
      update: (_entity, data) => data,
      draw: () => undefined,
    });
  // The local player stands out of every shot's way.
  Object.assign(game.local, { x: 850, y: 300 });
  return game;
}

test("a shot with nothing in its way carries its full range", () => {
  const game = session();
  const ended = traceShot(game, { x: 100, y: 300 }, 0, 200, "me");
  expect(ended).toEqual({ end: { x: 300, y: 300 }, struck: null, wall: false });
});

test("a wall stops a shot where it meets it", () => {
  const game = session();
  const ended = traceShot(game, { x: 100, y: 100 }, 0, 500, "me");
  expect(ended.struck).toBeNull();
  expect(ended.wall).toBe(true);
  expect(ended.end.x).toBeCloseTo(200);
});

test("a shot stops at the first solid body in its way, never its shooter nor a ghost", () => {
  const game = session();
  const near = spawnEntity(game, "dummy", 200, 300, {});
  spawnEntity(game, "dummy", 260, 300, {});
  spawnEntity(game, "ghost", 150, 300, {});
  const ended = traceShot(game, { x: 100, y: 300 }, 0, 500, "me");
  expect(ended.struck).toBe(near);
  expect(ended.end.x).toBeCloseTo(185);
  expect(traceShot(game, { x: 100, y: 300 }, 0, 500, near.id).struck).not.toBe(
    near,
  );
});

test("a body behind a wall is safe; one beside the line is missed", () => {
  const game = session();
  spawnEntity(game, "dummy", 400, 100, {});
  spawnEntity(game, "dummy", 200, 340, {});
  expect(traceShot(game, { x: 100, y: 100 }, 0, 500, "me").struck).toBeNull();
  expect(traceShot(game, { x: 100, y: 300 }, 0, 500, "me").struck).toBeNull();
});

test("fan spreads aims evenly across the arc, centred on the aim", () => {
  expect(fan(1, 2, 1)).toEqual([1]);
  expect(fan(0, 1, 3)).toEqual([-0.5, 0, 0.5]);
});
