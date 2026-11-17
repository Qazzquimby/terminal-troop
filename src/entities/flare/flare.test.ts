import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  emittedLights,
  isLit,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { fireFlare, flare } from "./index.js";

const DT = 1 / 60;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  holdingUse: false,
  secondary: false,
  interact: false,
  drop: false,
};
const config = testEntitiesConfig.flare;

/** The dev square, all one dark room; the player stands at the left end of its clear middle row. */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "FLARE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    flare.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x: 100, y: 300, prevX: 100, prevY: 300 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

const flares = (game: Session): WorldEntity[] => {
  const kind = game.kindIds.get("flare");
  return [...game.entities.values()].filter((entity) => entity.kind === kind);
};

test("a flare flies its range, lands and lights the dark round it red for its burn, then goes out", () => {
  const game = world();
  const far = { x: 100 + 400 + 100, y: 300 };
  expect(isLit(game, far)).toBe(false);
  fireFlare(game, game.local, { aim: 0, range: 400 });
  run(game, 1.5);
  const [landed] = flares(game);
  expect(landed?.x).toBeGreaterThan(100 + 400);
  expect(landed?.x).toBeLessThan(100 + 400 + 30);
  expect(emittedLights(game)).toContainEqual(
    expect.objectContaining({ tint: config.light.tint }),
  );
  expect(isLit(game, far)).toBe(true);

  run(game, config.seconds - 1);
  expect(flares(game)).toHaveLength(1);
  run(game, 1.5);
  expect(flares(game)).toHaveLength(0);
  expect(isLit(game, far)).toBe(false);
});

test("a flare stops at a body in its way and stings it", () => {
  const game = world();
  const zombie = spawnEntity(
    game,
    "zombie",
    300,
    300,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  stun(game, zombie.id, 60);
  const health = zombie.health;
  fireFlare(game, game.local, { aim: 0, range: 600 });
  run(game, 1.5);
  expect(zombie.health).toBe(health - config.damage);
  expect(flares(game)[0]?.x).toBeLessThan(300);
});

test("a flare stops at a wall", () => {
  const game = world();
  // The pillar at columns 4-5, rows 1-2: x 200-300, y 50-150.
  Object.assign(game.local, { x: 100, y: 100, prevX: 100, prevY: 100 });
  fireFlare(game, game.local, { aim: 0, range: 600 });
  run(game, 1.5);
  expect(flares(game)[0]?.x).toBeLessThan(200);
});
