import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createSession,
  registerContent,
  spawnEntity,
  stun,
  updateSession,
} from "../../sim/index.js";
import type { Session, WorldEntity } from "../../sim/index.js";
import { crossCells } from "../blast.js";
import { freshZombie, zombie as zombieContent } from "../zombie/index.js";
import { bomb } from "./index.js";

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
const config = testEntitiesConfig.bomb;

/**
 * The dev square, 50px cells, its 2x2 pillars at columns 4-5, rows 1-2 and columns 12-13, rows
 * 9-10; the player stands in its bottom-left corner, out of every burst's way.
 */
function world(): Session {
  const game = createSession(
    "me",
    "ME",
    "BOMB",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, [
    zombieContent.create(testEntitiesConfig),
    bomb.create(testEntitiesConfig),
  ]);
  Object.assign(game.local, { x: 870, y: 570, prevX: 870, prevY: 570 });
  return game;
}

function run(game: Session, seconds: number): void {
  for (let step = 0; step < Math.round(seconds / DT); step++)
    updateSession(game, idle, DT);
}

/** The middle of the cell at (`col`, `row`). */
const middle = (col: number, row: number) => ({
  x: (col + 0.5) * 50,
  y: (row + 0.5) * 50,
});

/** A zombie in the middle of the cell at (`col`, `row`), stunned so it stays there. */
function zombieAt(game: Session, col: number, row: number): WorldEntity {
  const { x, y } = middle(col, row);
  const zombie = spawnEntity(
    game,
    "zombie",
    x,
    y,
    freshZombie(1, game.worldTime, testEntitiesConfig.zombie),
  );
  stun(game, zombie.id, 60);
  return zombie;
}

const bombAt = (game: Session, col: number, row: number) => {
  const { x, y } = middle(col, row);
  return spawnEntity(game, "bomb", x, y, { laidAt: game.worldTime });
};

const solid = (game: Session, col: number, row: number) =>
  game.world.map.solid[row * game.world.map.cols + col] === 1;

test("each arm runs on through the first wall it breaks and stops at the second, or at the map's edge", () => {
  // A row of 12 cells, walls at 3, 5 and 7, the bomb in cell 1.
  const solidRow = new Uint8Array(12);
  for (const at of [3, 5, 7]) solidRow[at] = 1;
  const { cells, walls } = crossCells(
    { cols: 12, rows: 1, solid: solidRow },
    1,
    0,
    { reach: 8, walls: 2 },
  );
  expect(walls).toEqual([3, 5]);
  // The middle, right to the second wall, then left to the edge; up and down are off the map.
  expect(cells).toEqual([
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [0, 0],
  ]);
});

test("an arm reaches no further than its reach on open floor", () => {
  const { cells } = crossCells(
    { cols: 30, rows: 1, solid: new Uint8Array(30) },
    10,
    0,
    { reach: 8, walls: 2 },
  );
  expect(Math.max(...cells.map(([col]) => col))).toBe(18);
  expect(Math.min(...cells.map(([col]) => col))).toBe(2);
});

test("a bomb waits out its fuse, then knocks down the walls in its arms and kills what stands in them, not what stands off them", () => {
  const game = world();
  const self = bombAt(game, 4, 5);
  const inArm = zombieAt(game, 7, 5);
  const offArm = zombieAt(game, 7, 7);
  expect(solid(game, 4, 2)).toBe(true);
  expect(solid(game, 4, 1)).toBe(true);

  run(game, config.fuse - 0.2);
  expect(game.entities.has(self.id)).toBe(true);
  expect(game.entities.has(inArm.id)).toBe(true);

  run(game, 0.3);
  expect(game.entities.has(self.id)).toBe(false);
  expect(game.entities.has(inArm.id)).toBe(false);
  expect(game.entities.has(offArm.id)).toBe(true);
  // Up from row 5, the arm breaks both rows of the pillar above it.
  expect(solid(game, 4, 2)).toBe(false);
  expect(solid(game, 4, 1)).toBe(false);
  // Its neighbour column, off the arm, stands.
  expect(solid(game, 5, 2)).toBe(true);
});

test("a bomb caught in another's burst goes off at once, so they chain", () => {
  const game = world();
  bombAt(game, 2, 5);
  // Laid a whole fuse later, it would wait that long but for the first bomb's burst.
  run(game, 1);
  const second = bombAt(game, 6, 5);
  const beyond = zombieAt(game, 6, 8);
  run(game, config.fuse - 1 + 0.2);
  expect(game.entities.has(second.id)).toBe(false);
  expect(game.entities.has(beyond.id)).toBe(false);
});
