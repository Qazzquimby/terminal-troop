import { expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { circleAhead, entitiesIn, playersIn } from "./reach.js";
import { applyRemoteState, createSession } from "./session.js";

function session() {
  const game = createSession(
    "me",
    "ME",
    "REACH",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerEntityType(game, "post", {
    radius: 10,
    maxHealth: 10,
    data: z.null(),
    draw: () => undefined,
  });
  return game;
}

test("the circle ahead sits the given distance along the facing", () => {
  const { center, radius } = circleAhead(
    { x: 100, y: 100 },
    Math.PI / 2,
    40,
    20,
  );
  expect(center.x).toBeCloseTo(100);
  expect(center.y).toBeCloseTo(140);
  expect(radius).toBe(20);
});

test("finds every world entity touching the circle, edge included, and nothing else", () => {
  const game = session();
  const inside = spawnEntity(game, "post", 300, 300, null);
  const touching = spawnEntity(game, "post", 330, 300, null);
  spawnEntity(game, "post", 331, 300, null);
  const area = { center: { x: 300, y: 300 }, radius: 20 };
  expect(entitiesIn(game, area)).toEqual([inside, touching]);
});

test("never finds a player", () => {
  const game = session();
  Object.assign(game.local, { x: 300, y: 300 });
  expect(entitiesIn(game, { center: { x: 300, y: 300 }, radius: 50 })).toEqual(
    [],
  );
});

test("finds every player touching the circle but the one left out, and no world entity", () => {
  const game = session();
  Object.assign(game.local, { x: 300, y: 300 });
  const near = (id: string, x: number) => {
    applyRemoteState(game, {
      id,
      name: id,
      x,
      y: 300,
      aim: 0,
      health: 100,
      epoch: 0,
      content: {},
    });
    return game.players.get(id);
  };
  const touching = near("touching", 334);
  near("beyond", 335);
  spawnEntity(game, "post", 300, 300, null);
  const area = { center: { x: 300, y: 300 }, radius: 20 };
  expect(playersIn(game, area)).toEqual([game.local, touching]);
  expect(playersIn(game, area, "me")).toEqual([touching]);
});
