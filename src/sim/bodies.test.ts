import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { livingBodies } from "./bodies.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { createSession } from "./session.js";

function crowdedSession() {
  const game = createSession(
    "me",
    "ME",
    "BODIES",
    "dev",
    testSfx(),
    testSimConfig,
  );
  Object.assign(game.local, { x: 400, y: 300 });
  registerEntityType(game, "rock", {
    radius: 10,
    maxHealth: 10,
    data: z.null(),
    draw: () => undefined,
  });
  return game;
}

test("living bodies near a point are those within its range, in the order of all of them", () => {
  const game = crowdedSession();
  [500, 420, 460, 300, 445].forEach((x) => {
    spawnEntity(game, "rock", x, 300, null);
  });
  const near = { at: { x: 440, y: 300 }, range: 40 };

  const all = livingBodies(game);
  const within = livingBodies(game, null, near);

  expect(within).toEqual(
    all.filter((body) => Math.hypot(body.x - 440, body.y - 300) <= 40),
  );
  expect(within.map((body) => body.x)).toEqual([400, 420, 460, 445]);
});

test("living bodies near a point reach every body when the range is not finite", () => {
  const game = crowdedSession();
  spawnEntity(game, "rock", 5000, 300, null);

  expect(
    livingBodies(game, null, { at: { x: 0, y: 0 }, range: Infinity }),
  ).toEqual(livingBodies(game));
});
