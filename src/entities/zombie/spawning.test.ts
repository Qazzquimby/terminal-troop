import { mean } from "lodash-es";
import { expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../../integration/sim-config.js";
import {
  AREA,
  createPlayer,
  createSession,
  dangerWeight,
  isLit,
  mulberry32,
  randomFreePosition,
  registerContent,
  remoteness,
  updateSession,
} from "../../sim/index.js";
import type {
  Controls,
  DangerConfig,
  Session,
  SimConfig,
} from "../../sim/index.js";
import type { EntitiesConfig } from "../index.js";
import { entityContent } from "../index.js";
import { spawnAllowed } from "../spawn-rules.js";
import { spawnWeight } from "./spawning.js";
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
  drop: false,
  holdingUse: false,
};

const SPAWNING = testEntitiesConfig.zombie.spawning;

/**
 * A new world with its cruiser and no starting zombies, blind ones so none runs at the player,
 * spawning by `spawning`.
 */
function world(
  spawning: SpawningConfig = SPAWNING,
  sim: SimConfig = testSimConfig,
): Session {
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      sightRange: 0,
      spawn: { ...testEntitiesConfig.zombie.spawn, count: 0 },
      spawning,
    },
  };
  const game = createSession("me", "ME", "SPAWNS", "standard", testSfx(), sim);
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  return game;
}

/** A zombie spawned: when, and how far it was from the nearest player. */
interface Spawned {
  readonly time: number;
  readonly distance: number;
}

/** Runs `seconds` standing still, returning each zombie that spawned meanwhile. */
function play(game: Session, seconds: number): Spawned[] {
  const kind = game.kindIds.get("zombie");
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

function zombies(game: Session): number {
  const kind = game.kindIds.get("zombie");
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
  expect(zombies(game)).toBe(3);
  const kind = game.kindIds.get("zombie");
  const fallen = [...game.entities.values()].find(
    (entity) => entity.kind === kind,
  );
  if (fallen !== undefined) fallen.health = 0;
  play(game, DT);
  expect(zombies(game)).toBe(2);
  expect(play(game, SPAWNING.lastGap + 0.1)).toHaveLength(1);
  expect(zombies(game)).toBe(3);
});

test("no zombie spawns within the unseen distance of any player", () => {
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
    group: { min: 1, max: 1, spread: 100 },
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

const GROUP_OF_FIVE: SpawningConfig = {
  ...SPAWNING,
  maxAlive: 1000,
  group: { min: 5, max: 5, spread: 100 },
};

/** Where each zombie in the world stands. */
function zombiePoints(game: Session): { x: number; y: number }[] {
  const kind = game.kindIds.get("zombie");
  return [...game.entities.values()]
    .filter((entity) => entity.kind === kind)
    .map(({ x, y }) => ({ x, y }));
}

test("a spawn brings a whole group at once, standing together, apart and unseen", () => {
  // Placing members draws from Math.random, and a draw can land a member somewhere it may not
  // stand (lit, or seen), cutting the group short; seeded so the run is the same every time.
  vi.spyOn(Math, "random").mockImplementation(mulberry32(1));
  const game = world(GROUP_OF_FIVE);
  const spawned = play(game, SPAWNING.firstGap + 0.1);
  vi.restoreAllMocks();
  expect(spawned).toHaveLength(5);
  expect(new Set(spawned.map(({ time }) => time)).size).toBe(1);
  for (const { distance } of spawned)
    expect(distance).toBeGreaterThanOrEqual(SPAWNING.unseenDistance);
  const points = zombiePoints(game);
  const [first] = points;
  for (const [index, point] of points.entries()) {
    expect(
      Math.hypot(point.x - (first?.x ?? 0), point.y - (first?.y ?? 0)),
    ).toBeLessThanOrEqual(GROUP_OF_FIVE.group.spread + 10);
    for (const other of points.slice(index + 1))
      expect(
        Math.hypot(point.x - other.x, point.y - other.y),
      ).toBeGreaterThanOrEqual(testEntitiesConfig.zombie.radius * 2 - 10);
  }
});

test("groups come in sizes between the least and the most", () => {
  const game = world({
    ...SPAWNING,
    maxAlive: 1000,
    firstGap: 0.5,
    lastGap: 0.5,
    rampSeconds: 1,
    group: { min: 1, max: 5, spread: 100 },
  });
  const sizes = new Map<number, number>();
  // Short gaps, so enough groups arrive without simulating a crowd for minutes.
  for (const { time } of play(game, 10))
    sizes.set(time, (sizes.get(time) ?? 0) + 1);
  const counts = [...sizes.values()];
  expect(counts.length).toBeGreaterThan(10);
  for (const count of counts) {
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(5);
  }
  expect(new Set(counts).size).toBeGreaterThan(1);
});

test("a group that would overfill the world comes short", () => {
  const game = world({ ...GROUP_OF_FIVE, maxAlive: 3 });
  expect(play(game, SPAWNING.firstGap + 0.1)).toHaveLength(3);
});

test("each zombie a new world scatters is gathered into a group as spawning begins", () => {
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    zombie: {
      ...testEntitiesConfig.zombie,
      sightRange: 0,
      spawning: { ...GROUP_OF_FIVE, group: { min: 3, max: 3, spread: 100 } },
    },
  };
  const game = createSession(
    "me",
    "ME",
    "SPAWNS",
    "standard",
    testSfx(),
    testSimConfig,
  );
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  const leaders = zombies(game);
  expect(leaders).toBeGreaterThan(0);
  play(game, DT);
  expect(zombies(game)).toBe(leaders * 3);
});

/** The test tuning, its world as dangerous as `danger` makes it; the layout is the same. */
function dangerous(danger: DangerConfig): SimConfig {
  return {
    ...testSimConfig,
    world: {
      ...testSimConfig.world,
      generation: { ...testSimConfig.world.generation, danger },
    },
  };
}

/** How remote each zombie that spawned over `seconds` is, with no cap. */
function spawnSpots(danger: DangerConfig, seconds: number) {
  const game = world({ ...SPAWNING, maxAlive: 1000 }, dangerous(danger));
  const kind = game.kindIds.get("zombie");
  play(game, seconds);
  return [...game.entities.values()]
    .filter((entity) => entity.kind === kind)
    .map(({ x, y }) => remoteness(game.world, { x, y }));
}

test("spawns favour dangerous spots: far from the road, and towards the exit's side", () => {
  // Spawns draw from Math.random; seeded here so the comparison is the same every run.
  const seeded = (danger: DangerConfig) => {
    vi.spyOn(Math, "random").mockImplementation(mulberry32(11));
    const spots = spawnSpots(danger, SPAWNING.rampSeconds + 30);
    vi.restoreAllMocks();
    return {
      count: spots.length,
      road: mean(spots.map(({ road }) => road)),
      across: mean(spots.map(({ across }) => across)),
    };
  };
  const even = seeded({ road: 0, right: 0 });
  const far = seeded({ road: 20, right: 0 });
  const right = seeded({ road: 0, right: 20 });

  expect(far.count).toBeGreaterThan(20);
  // Spawns keep out of the sunlit road and yards, so every spot open to them is already some way
  // from the road, and favouring the farthest moves them less.
  expect(far.road).toBeGreaterThan(even.road + 0.03);
  expect(right.across).toBeGreaterThan(even.across + 0.05);
});

/** The middle of the first cell of the kind `area` codes that `keep` keeps. */
function cellWhere(
  game: Session,
  area: number,
  keep: (at: { x: number; y: number }) => boolean,
): { x: number; y: number } {
  const { cell, cols } = game.world.map;
  const spots = [...game.world.layout.area.entries()]
    .filter(([, code]) => code === area)
    .map(([i]) => ({
      x: ((i % cols) + 0.5) * cell,
      y: (Math.floor(i / cols) + 0.5) * cell,
    }));
  const spot = spots.find(keep);
  if (spot === undefined) throw new Error("no such cell");
  return spot;
}

test("a spawn's weight is the world's danger weight there, and nothing in the start", () => {
  const game = world();
  const { start } = game.world.layout;
  const inStart = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  expect(spawnAllowed(game, inStart)).toBe(false);
  expect(spawnWeight(game, inStart)).toBe(0);
  const dark = cellWhere(game, AREA.room, (at) => !isLit(game, at));
  const { road, across } = remoteness(game.world, dark);
  const { danger } = testSimConfig.world.generation;
  expect(spawnWeight(game, dark)).toBeCloseTo(
    (1 + danger.road * road) * (1 + danger.right * across),
  );
  expect(spawnWeight(game, dark)).toBe(dangerWeight(game.world, dark));
});

test("nothing spawns in light: not in the sunlit road, nor a lit room", () => {
  const game = world();
  const middle = { x: game.world.W / 2, y: game.world.H / 2 };
  const road = cellWhere(game, AREA.road, (at) => at.x >= middle.x);
  expect(isLit(game, road)).toBe(true);
  expect(spawnAllowed(game, road)).toBe(false);
  expect(spawnWeight(game, road)).toBe(0);
  const litRoom = cellWhere(game, AREA.room, (at) => isLit(game, at));
  expect(spawnAllowed(game, litRoom)).toBe(false);
});

test("a new world's first zombies favour the same spots", () => {
  const first = (danger: DangerConfig) => {
    const entities: EntitiesConfig = {
      ...testEntitiesConfig,
      zombie: {
        ...testEntitiesConfig.zombie,
        spawn: { ...testEntitiesConfig.zombie.spawn, count: 200 },
      },
    };
    const game = createSession(
      "me",
      "ME",
      "FIRST",
      "standard",
      testSfx(),
      dangerous(danger),
      { rng: mulberry32(4) },
    );
    registerContent(game, entityContent(entities));
    for (const content of game.contents) content.populate(game);
    const kind = game.kindIds.get("zombie");
    return [...game.entities.values()]
      .filter((entity) => entity.kind === kind)
      .map(({ x, y }) => remoteness(game.world, { x, y }).across);
  };
  // Weighed 1 + 20a, an even spread across averages 0.5, a favoured one about two thirds.
  expect(mean(first({ road: 0, right: 20 }))).toBeGreaterThan(
    mean(first({ road: 0, right: 0 })) + 0.08,
  );
});
