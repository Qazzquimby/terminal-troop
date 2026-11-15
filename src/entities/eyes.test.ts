import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  createSession,
  eyesOf,
  hurtPlayer,
  isLookedAt,
  lookersAt,
  looksAt,
  notices,
  spawnEntity,
  stun,
} from "../sim/index.js";
import type { Session, WorldEntity } from "../sim/index.js";
import { freshExploder } from "./exploder/index.js";
import { entityContent } from "./index.js";
import { freshStatue } from "./statue/index.js";
import { freshBlindDog } from "./blind-dog/index.js";
import { freshHoarder } from "./hoarder/index.js";
import { freshStalker } from "./stalker/index.js";
import { freshSleeper } from "./sleeper/index.js";
import { freshZombie } from "./zombie/index.js";

const { vision } = testSimConfig;
const entities = testEntitiesConfig;

/** The dev square, every kind registered and none spawned; the player stands at (100, 300). */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "EYES",
    "dev",
    testSfx(),
    testSimConfig,
  );
  for (const entry of entityContent(entities)) entry.register(game);
  Object.assign(game.local, { x: 100, y: 300, aim: 0 });
  return game;
}

const at = (game: Session, name: string, data: unknown): WorldEntity =>
  spawnEntity(game, name, 400, 300, data);

test("a player looks down its aim, as far as its look range, and sees a small circle all round", () => {
  const game = world();
  expect(eyesOf(game, game.local)).toEqual({
    x: 100,
    y: 300,
    cone: { direction: 0, angle: vision.coneAngle, range: vision.lookRange },
    around: vision.surroundingsRadius,
  });
});

test("a ghost sees nothing", () => {
  const game = world();
  hurtPlayer(game, game.local, game.local.maxHealth);
  expect(eyesOf(game, game.local)).toBeNull();
});

test("each kind's eyes: zombie and hoarder look down their facing, statue and sleeper see only all round, and the blind dog and exploder are blind", () => {
  const game = world();
  const now = game.worldTime;
  const zombie = at(game, "zombie", {
    ...freshZombie(1, now, entities.zombie),
    facing: 1,
  });
  expect(eyesOf(game, zombie)).toMatchObject({
    cone: {
      direction: 1,
      angle: vision.coneAngle,
      range: entities.zombie.sightRange,
    },
    around: Math.min(vision.surroundingsRadius, entities.zombie.sightRange),
  });
  const hoarder = at(game, "hoarder", { ...freshHoarder(now), facing: 2 });
  expect(eyesOf(game, hoarder)).toMatchObject({
    cone: { direction: 2, range: entities.hoarder.sightRange },
  });
  const stalker = at(game, "stalker", { ...freshStalker(now), facing: 3 });
  expect(eyesOf(game, stalker)).toMatchObject({
    cone: { direction: 3, range: vision.lookRange },
  });
  expect(eyesOf(game, at(game, "statue", freshStatue(now)))).toMatchObject({
    cone: null,
    around: entities.statue.sightRange,
  });
  expect(
    eyesOf(game, at(game, "sleeper", freshSleeper(now, entities.sleeper))),
  ).toMatchObject({ cone: null, around: entities.sleeper.sightRange });
  expect(eyesOf(game, at(game, "blindDog", freshBlindDog(1, now)))).toBeNull();
  expect(eyesOf(game, at(game, "exploder", freshExploder(1, now)))).toBeNull();
});

test("a stunned entity sees nothing", () => {
  const game = world();
  const zombie = at(game, "zombie", freshZombie(1, 0, entities.zombie));
  stun(game, zombie.id, 5);
  expect(eyesOf(game, zombie)).toBeNull();
});

test("looking is down the cone only; noticing takes in the circle all round too", () => {
  const game = world();
  const ahead = { x: 300, y: 300 };
  const behind = { x: 100 - vision.surroundingsRadius / 2, y: 300 };
  expect(looksAt(game, game.local, ahead)).toBe(true);
  expect(looksAt(game, game.local, behind)).toBe(false);
  expect(notices(game, game.local, behind)).toBe(true);
  expect(notices(game, game.local, ahead, 100)).toBe(false);
  expect(
    looksAt(game, game.local, { x: 100 + vision.lookRange + 10, y: 300 }),
  ).toBe(false);
});

test("who looks at a point: every living body whose cone takes it in, but those left out", () => {
  const game = world();
  const zombie = at(game, "zombie", {
    ...freshZombie(1, 0, entities.zombie),
    facing: Math.PI,
  });
  const target = { x: 250, y: 300 };
  expect(lookersAt(game, target)).toEqual([game.local, zombie]);
  expect(
    lookersAt(game, target, { except: (body) => body.id === zombie.id }),
  ).toEqual([game.local]);
  game.local.aim = Math.PI;
  expect(lookersAt(game, target)).toEqual([zombie]);
  expect(isLookedAt(game, target)).toBe(true);
  // A body never counts as looking at itself.
  expect(lookersAt(game, zombie)).toEqual([]);
});
