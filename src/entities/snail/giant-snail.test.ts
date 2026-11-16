import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  destroyedWalls,
  isAreaFree,
  registerContent,
  spawnEntity,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { freshSnail, giantSnail, snail, SnailState } from "./index.js";

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

/** The column of the dev square the tests wall off. */
const WALL_COL = 9;

/** The dev square with both snails; the player stands at (750, 325), across column 9. */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "GIANT",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    snail.create(testEntitiesConfig),
    giantSnail.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x: 750, y: 325, prevX: 750, prevY: 325 });
  return game;
}

/** Walls column 9 from `top` to `bottom` rows, both included. */
function wallAcross(game: Session, top: number, bottom: number): void {
  const { map } = game.world;
  for (let row = top; row <= bottom; row++)
    map.solid[row * map.cols + WALL_COL] = 1;
}

/** Whether every cell of column 9 from `top` to `bottom` is still a wall. */
function standing(game: Session, top: number, bottom: number): boolean {
  const { map } = game.world;
  for (let row = top; row <= bottom; row++)
    if (map.solid[row * map.cols + WALL_COL] !== 1) return false;
  return true;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

function spawnAt(game: Session, kind: string, x: number): WorldEntity {
  return spawnEntity(game, kind, x, 325, freshSnail("me", game.worldTime));
}

test("a giant snail fills two cells by two and creeps faster than the snail", () => {
  const game = world();
  const giant = spawnAt(game, "giantSnail", 300);
  const small = spawnEntity(
    game,
    "snail",
    300,
    500,
    freshSnail("me", game.worldTime),
  );
  run(game, 0.5);
  const { cell } = game.world.map;
  expect(giant.radius * 2).toBeGreaterThan(cell * 1.5);
  expect(giant.radius * 2).toBeLessThanOrEqual(cell * 2);
  expect(Math.hypot(giant.vx, giant.vy)).toBeGreaterThan(
    Math.hypot(small.vx, small.vy),
  );
});

test("pressed against a wall it cannot go round, it breaks through after 5 seconds and on to its quarry", () => {
  const game = world();
  const rows = game.world.map.rows;
  wallAcross(game, 0, rows - 1);
  const giant = spawnAt(game, "giantSnail", 300);
  // About 1.5s to reach the wall; still pressing 5s later the wall stands.
  run(game, 5);
  expect(standing(game, 0, rows - 1)).toBe(true);
  expect(SnailState.parse(giant.data).pressed).toBeGreaterThan(2);
  expect(giant.x).toBeLessThan(WALL_COL * 50);

  run(game, 3);
  expect(standing(game, 0, rows - 1)).toBe(false);
  expect(destroyedWalls.get(game).length).toBeGreaterThan(0);
  // Only what it pressed came down: a gap its own size, no more.
  expect(destroyedWalls.get(game).length).toBeLessThanOrEqual(3);

  run(game, 10);
  expect(giant.x).toBeGreaterThan((WALL_COL + 1) * 50);
  expect(game.local.health).toBe(0);
});

test("it goes round a short wall rather than through it, where that is quicker", () => {
  const game = world();
  wallAcross(game, 4, 8);
  spawnAt(game, "giantSnail", 300);
  run(game, 20);
  expect(standing(game, 4, 8)).toBe(true);
  expect(game.local.health).toBe(0);
});

test("the snail never breaks walls: a wall it cannot go round stops it", () => {
  const game = world();
  const rows = game.world.map.rows;
  wallAcross(game, 0, rows - 1);
  const small = spawnAt(game, "snail", 400);
  run(game, 20);
  expect(standing(game, 0, rows - 1)).toBe(true);
  expect(SnailState.parse(small.data).pressed).toBe(0);
  expect(game.local.health).toBeGreaterThan(0);
});

test("it fits through no gap narrower than itself", () => {
  const game = world();
  const rows = game.world.map.rows;
  wallAcross(game, 0, rows - 1);
  // A gap one cell wide at row 6: the snail slips through, the giant one cannot.
  game.world.map.solid[6 * game.world.map.cols + WALL_COL] = 0;
  const giant = spawnAt(game, "giantSnail", 300);
  expect(
    isAreaFree(game.world.map, WALL_COL * 50 + 25, 325, giant.radius),
  ).toBe(false);
  run(game, 4);
  expect(giant.x).toBeLessThan(WALL_COL * 50);
});
