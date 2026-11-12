import { expect, test } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  createPlayer,
  createSession,
  mulberry32,
  randomFreePosition,
  registerContent,
  updateSession,
} from "../../sim/index.js";
import type { Controls, Session, SimConfig } from "../../sim/index.js";
import type { EntitiesConfig } from "../index.js";
import { entityContent } from "../index.js";
import type { SpawningConfig } from "./spawning.js";

const DT = 1 / 60;

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

const SPAWNING = testEntitiesConfig.chaser.spawning;

/**
 * A new world with its cruiser and no starting chasers, blind ones so none runs at the player,
 * spawning by `spawning`.
 */
function world(
  spawning: SpawningConfig = SPAWNING,
  sim: SimConfig = testSimConfig,
): Session {
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    chaser: {
      ...testEntitiesConfig.chaser,
      sightRange: 0,
      spawn: { ...testEntitiesConfig.chaser.spawn, count: 0 },
      spawning,
    },
  };
  const game = createSession("me", "ME", "SPAWNS", "standard", testSfx(), sim);
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  return game;
}

/** A chaser spawned: when, and how far it was from the nearest player. */
interface Spawned {
  readonly time: number;
  readonly distance: number;
}

/** Runs `seconds` standing still, returning each chaser that spawned meanwhile. */
function play(game: Session, seconds: number): Spawned[] {
  const kind = game.kindIds.get("chaser");
  const known = new Set(game.entities.keys());
  const spawned: Spawned[] = [];
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, still, DT);
    for (const entity of game.entities.values()) {
      if (known.has(entity.id)) continue;
      known.add(entity.id);
      if (entity.kind !== kind) continue;
      const distances = [...game.players.values()].map((player) =>
        Math.hypot(player.x - entity.x, player.y - entity.y),
      );
      spawned.push({
        time: game.worldTime,
        distance: Math.min(...distances),
      });
    }
  }
  return spawned;
}

function chasers(game: Session): number {
  const kind = game.kindIds.get("chaser");
  return [...game.entities.values()].filter((entity) => entity.kind === kind)
    .length;
}

test("nothing spawns before the first gap, and one spawns once it is up", () => {
  const game = world();
  expect(play(game, SPAWNING.firstGap - 0.1)).toEqual([]);
  expect(play(game, 0.2)).toHaveLength(1);
});

test("the gap falls from the first to the last over the ramp", () => {
  const game = world({ ...SPAWNING, maxAlive: 1000 });
  const times = play(game, SPAWNING.rampSeconds + 4 * SPAWNING.lastGap).map(
    ({ time }) => time,
  );
  const gaps = times.slice(1).map((time, index) => time - (times[index] ?? 0));
  expect(times[0]).toBeCloseTo(SPAWNING.firstGap, 1);
  expect(gaps[0]).toBeLessThan(SPAWNING.firstGap);
  for (const [index, gap] of gaps.slice(1).entries())
    expect(gap).toBeLessThanOrEqual((gaps[index] ?? 0) + DT);
  expect(gaps.at(-1)).toBeCloseTo(SPAWNING.lastGap, 1);
});

test("spawning stops at the cap, and goes on once one falls", () => {
  const game = world({ ...SPAWNING, maxAlive: 3 });
  play(game, SPAWNING.rampSeconds + 4 * SPAWNING.lastGap);
  expect(chasers(game)).toBe(3);
  const kind = game.kindIds.get("chaser");
  const fallen = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (fallen !== undefined) fallen.health = 0;
  play(game, DT);
  expect(chasers(game)).toBe(2);
  expect(play(game, SPAWNING.lastGap + 0.1)).toHaveLength(1);
  expect(chasers(game)).toBe(3);
});

test("no chaser spawns within the unseen distance of any player", () => {
  const game = world({ ...SPAWNING, maxAlive: 1000 });
  const other = createPlayer(
    "other",
    "OTHER",
    randomFreePosition(game.world, 14, mulberry32(5)),
    testSimConfig,
  );
  game.players.set(other.id, other);
  const spawned = play(game, SPAWNING.rampSeconds + 10);
  expect(spawned.length).toBeGreaterThan(10);
  for (const { distance } of spawned)
    expect(distance).toBeGreaterThanOrEqual(SPAWNING.unseenDistance);
});

test("only the host spawns", () => {
  const game = world();
  game.hosting = false;
  expect(play(game, SPAWNING.rampSeconds)).toEqual([]);
});

test("in a world of 100 by 80 cells, a spawn every 12 seconds at first still finds room 700px from the players", () => {
  const spawning: SpawningConfig = {
    firstGap: 12,
    lastGap: 1,
    rampSeconds: 300,
    maxAlive: 120,
    tries: 24,
    unseenDistance: 700,
  };
  const game = world(spawning, {
    ...testSimConfig,
    world: { ...testSimConfig.world, cell: 50, cols: 100, rows: 80 },
  });
  expect([game.world.W, game.world.H]).toEqual([5000, 4000]);
  const spawned = play(game, 60);
  expect(spawned.length).toBeGreaterThan(3);
  expect(spawned[0]?.time).toBeCloseTo(spawning.firstGap, 1);
  for (const { distance } of spawned)
    expect(distance).toBeGreaterThanOrEqual(spawning.unseenDistance);
});
