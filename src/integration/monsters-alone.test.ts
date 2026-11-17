import { sum } from "lodash-es";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import type { EntitiesConfig } from "../entities/index.js";
import { itemContent } from "../items/index.js";
import {
  createSession,
  hasKindTag,
  hurtPlayer,
  INERT_TAG,
  ITEM_TAG,
  mulberry32,
  registerContent,
  updateSession,
} from "../sim/index.js";
import type { Controls, Session, SimConfig } from "../sim/index.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

/*
 * Monsters hunt any body, each other included, but only within the engagement range of a living
 * player (#360): a world with no living player is left as it is, every monster in it alive and
 * every wall standing.
 *
 * Near players they do thin each other out. With the test config's `ignores` and exploder
 * `fuseOnHurt`, which mirror the shipped defaults, they should do so slowly: with every monster in
 * play wherever it is, as a world crowded with players would have it, a standard world keeps most
 * of the monsters it began with for half a minute, and its walls stand. With every kind ignoring
 * only its own, this seed fails both.
 *
 * It runs on a world without the exit's pull (#290): the dark, open ground round the exit draws
 * many monsters together, where they thin each other out much faster. That is by design, a
 * crowd at the goal, so it is not what this measures.
 */

// Ten steps a second rather than sixty, so half a minute runs fast: monsters move a few
// pixels a step, which changes nothing here.
const DT = 1 / 10;
const SECONDS = 30;

const still: Controls = {
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

// Monsters draw from Math.random; seeded so each run is the same.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(2));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `kind`'s config, drawn by the spawner at `weight`, from `after` seconds into the world. */
function weighed<T extends { readonly spawning: object }>(
  kind: T,
  weight: number,
  after = 0,
): T {
  return { ...kind, spawning: { ...kind.spawning, weight, after } };
}

/**
 * The test config with every monster in the spawner's draw at the shipped weights, zombies in
 * groups of one to five as well as the few it scatters, and the shipped spawner's head start: 5
 * minutes of rolls every 10s, half of them bringing nothing. Those that come late in a world come
 * as late here.
 */
const entities: EntitiesConfig = {
  ...testEntitiesConfig,
  spawner: { period: 10, nothing: 0.5, certainAfter: 1200, headStart: 300 },
  zombie: weighed(
    {
      ...testEntitiesConfig.zombie,
      spawning: {
        ...testEntitiesConfig.zombie.spawning,
        group: { min: 1, max: 5, spread: 100 },
      },
    },
    100,
  ),
  snail: weighed(testEntitiesConfig.snail, 30, 240),
  blindDog: weighed(testEntitiesConfig.blindDog, 30),
  exploder: weighed(testEntitiesConfig.exploder, 70),
  sleeper: weighed(testEntitiesConfig.sleeper, 50),
  statue: weighed(testEntitiesConfig.statue, 10, 180),
  stalker: weighed(testEntitiesConfig.stalker, 30, 240),
  hoarder: weighed(testEntitiesConfig.hoarder, 50),
  mineLayer: weighed(testEntitiesConfig.mineLayer, 10, 120),
  giantSnail: weighed(testEntitiesConfig.giantSnail, 5, 480),
  livingWall: weighed(testEntitiesConfig.livingWall, 10, 120),
  gloom: weighed(testEntitiesConfig.gloom, 10, 180),
  doppelganger: weighed(testEntitiesConfig.doppelganger, 10, 180),
  thumper: weighed(testEntitiesConfig.thumper, 20, 120),
  tricycle: weighed(testEntitiesConfig.tricycle, 10, 180),
  birthdayBoy: weighed(testEntitiesConfig.birthdayBoy, 10, 180),
};

/** The test config, but with no extra danger nor darkness round the exit. */
const spreadOut: SimConfig = {
  ...testSimConfig,
  world: {
    ...testSimConfig.world,
    generation: {
      ...testSimConfig.world.generation,
      lights: { ...testSimConfig.world.generation.lights, exitShade: 0 },
      danger: { ...testSimConfig.world.generation.danger, exit: 0 },
    },
  },
};

/** Monsters in play only within 15 cells of a living player, as shipped. */
const shipped: SimConfig = {
  ...spreadOut,
  engagement: { range: spreadOut.world.cell * 15 },
};

/**
 * A standard test world on `config`, populated by the spawner's head start, its one player a
 * ghost.
 */
function emptyWorld(config: SimConfig): Session {
  const game = createSession(
    "me",
    "ME",
    "ALONE",
    "standard",
    testSfx(),
    config,
  );
  registerContent(game, [
    ...entityContent(entities),
    ...itemContent(testItemsConfig),
  ]);
  for (const content of game.contents) content.populate(game);
  hurtPlayer(game, game.local, Infinity);
  return game;
}

/** The ids of the world's living monsters: entities that are neither items nor inert. */
function monsters(game: Session): Set<string> {
  return new Set(
    [...game.entities.values()]
      .filter(
        (entity) =>
          entity.health > 0 &&
          !hasKindTag(game, entity.id, [INERT_TAG, ITEM_TAG]),
      )
      .map((entity) => entity.id),
  );
}

const solidCells = (game: Session): number => sum([...game.world.map.solid]);

/** Steps `game` for half a minute, and gives how many of its monsters live, and the walls lost. */
function leftAlone(game: Session): {
  first: number;
  alive: number;
  wallsLost: number;
} {
  const first = monsters(game);
  const walls = solidCells(game);
  for (let step = 0; step < SECONDS / DT; step++)
    updateSession(game, still, DT);
  const left = monsters(game);
  return {
    first: first.size,
    alive: [...first].filter((id) => left.has(id)).length,
    wallsLost: walls - solidCells(game),
  };
}

test("with no living player about, monsters leave one another be: every one lives and the walls stand", () => {
  const { first, alive, wallsLost } = leftAlone(emptyWorld(shipped));
  expect(first).toBeGreaterThan(10);
  expect(alive).toBe(first);
  expect(wallsLost).toBe(0);
});

test("all in play, monsters keep most of their number and the walls stand", () => {
  const { first, alive, wallsLost } = leftAlone(emptyWorld(spreadOut));
  expect(first).toBeGreaterThan(10);
  expect(alive / first).toBeGreaterThanOrEqual(0.75);
  expect(wallsLost).toBeLessThanOrEqual(10);
});
