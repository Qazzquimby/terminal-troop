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
import type { Controls, Session } from "../sim/index.js";
import {
  testEntitiesConfig,
  testItemsConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

/*
 * Monsters hunt any body, each other included, so a world left to them thins itself out. With
 * the test config's `ignores` and exploder `fuseOnHurt`, which mirror the shipped defaults, it
 * should do so slowly: a standard world with no living player keeps most of the monsters it began
 * with for half a minute, and its walls stand. With every kind ignoring only its own, this seed
 * fails both.
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
};

/** A standard test world, populated by the spawner's head start, its one player a ghost. */
function emptyWorld(): Session {
  const game = createSession(
    "me",
    "ME",
    "ALONE",
    "standard",
    testSfx(),
    testSimConfig,
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

test("left to themselves, with no player about, monsters keep most of their number and the walls stand", () => {
  const game = emptyWorld();
  const first = monsters(game);
  const walls = solidCells(game);
  for (let step = 0; step < SECONDS / DT; step++)
    updateSession(game, still, DT);
  const left = monsters(game);
  const alive = [...first].filter((id) => left.has(id)).length;
  expect(first.size).toBeGreaterThan(10);
  expect(alive / first.size).toBeGreaterThanOrEqual(0.75);
  expect(walls - solidCells(game)).toBeLessThanOrEqual(10);
});
