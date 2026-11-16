import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  isAreaFree,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import { placeStunTrap, stunTrap } from "../stun-trap/index.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { teleporter, TeleporterState } from "./index.js";

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
/** Sends 4 to 8 cells, so a send fits in the dev square. */
const config = {
  ...testEntitiesConfig.teleporter,
  distance: { min: 200, max: 400 },
};

/**
 * The dev square, 800 by 600, its pillars at x 200-300, y 50-150 and x 600-700, y 450-550, with
 * zombies, stun traps and teleporters; the player stands in its far corner.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "WARP",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    stunTrap.create(testEntitiesConfig),
    teleporter.create({ ...testEntitiesConfig, teleporter: config }),
  ]);
  Object.assign(game.local, { x: 750, y: 560, prevX: 750, prevY: 560 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

/** A pad at `x`, `y`, aimed `facing`, just laid. */
const padAt = (game: Session, x: number, y: number, facing = 0) =>
  spawnEntity(game, "teleporter", x, y, {
    since: game.worldTime,
    armed: false,
    facing,
    used: false,
  });

const stateOf = (pad: WorldEntity) => TeleporterState.parse(pad.data);

/** Puts the local player at `at`, at rest. */
const standAt = (game: Session, at: Point) =>
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });

test("a pad charges over its arming time, sending nothing off until it has", () => {
  const game = world();
  const pad = padAt(game, 100, 300);
  standAt(game, { x: 100, y: 300 });
  run(game, config.armSeconds - 0.2);
  expect(stateOf(pad).armed).toBe(false);
  expect(game.local).toMatchObject({ x: 100, y: 300 });

  run(game, 0.3);
  expect(game.local.x).not.toBe(100);
});

test("a body stepping on a charged pad lands clear, the way it is aimed, within its reach", () => {
  for (let trial = 0; trial < 10; trial++) {
    const game = world();
    const pad = padAt(game, 100, 300);
    run(game, config.armSeconds + 0.1);
    expect(stateOf(pad).armed).toBe(true);

    standAt(game, { x: 100, y: 300 });
    run(game, DT);
    const { x, y } = game.local;
    expect(y).toBeCloseTo(300, 5);
    expect(x - 100).toBeGreaterThanOrEqual(config.distance.min);
    expect(x - 100).toBeLessThanOrEqual(config.distance.max);
    expect(isAreaFree(game.world.map, x, y, game.local.radius)).toBe(true);
    // Placed there, not sliding from the pad.
    expect(game.local).toMatchObject({ prevX: x, prevY: y });
  }
});

test("once it has sent a body off, it charges again over its rearming time", () => {
  const game = world();
  const pad = padAt(game, 100, 300);
  run(game, config.armSeconds + 0.1);
  standAt(game, { x: 100, y: 300 });
  run(game, DT);
  expect(stateOf(pad)).toMatchObject({ armed: false, used: true });

  // Back on the pad while it charges: it stays put.
  standAt(game, { x: 100, y: 300 });
  run(game, config.rearmSeconds - 0.2);
  expect(game.local).toMatchObject({ x: 100, y: 300 });
  run(game, 0.3);
  expect(game.local.x).toBeGreaterThan(100 + config.distance.min - 1);
});

test("it sends monsters as it does players, but not inert things such as a stun trap", () => {
  const game = world();
  padAt(game, 100, 300, Math.PI / 2);
  placeStunTrap(game, { x: 100, y: 300 });
  const trap = [...game.entities.values()].at(-1);
  run(game, config.armSeconds + 0.1);
  const zombie = spawnEntity(
    game,
    "zombie",
    100,
    300,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  // Held still, but for the pad.
  stun(game, zombie.id, 10);
  run(game, DT);
  expect(zombie.x).toBeCloseTo(100, 5);
  // Aimed straight down, out 4 to 8 cells but the square is 6 high: no further than its floor.
  expect(zombie.y).toBeGreaterThanOrEqual(300 + config.distance.min);
  expect(trap).toMatchObject({ x: 100, y: 300 });
});

test("a body with nowhere clear to land stays put, and the pad stays charged", () => {
  const game = world();
  // Aimed off the left edge of the world.
  const pad = padAt(game, 100, 300, Math.PI);
  run(game, config.armSeconds + 0.1);
  standAt(game, { x: 100, y: 300 });
  run(game, 0.5);
  expect(game.local).toMatchObject({ x: 100, y: 300 });
  expect(stateOf(pad).armed).toBe(true);
});
