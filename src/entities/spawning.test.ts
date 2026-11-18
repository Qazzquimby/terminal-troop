import { mean, omit } from "lodash-es";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  testEntitiesConfig,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import {
  AREA,
  createPlayer,
  createSession,
  destroyWalls,
  dangerWeight,
  inRect,
  isAreaFree,
  isLit,
  mulberry32,
  randomFreePosition,
  registerContent,
  remoteness,
  roadDistanceAt,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type {
  Controls,
  DangerConfig,
  Point,
  Session,
  SimConfig,
  Sound,
  WorldKind,
} from "../sim/index.js";
import type { EntitiesConfig } from "./index.js";
import { entityContent } from "./index.js";
import { freshPeeper } from "./peeper/index.js";
import { relocate } from "./relocate.js";
import { freshSnail } from "./snail/index.js";
import { reachesRoad } from "./road-reach.js";
import { spanOf } from "./route.js";
import { spawnAllowed } from "./spawn-rules.js";
import {
  apartShare,
  arrivalPoint,
  groupRange,
  groupSize,
  nothingChance,
  spawnWeight,
  watchedAt,
} from "./spawning.js";
import type { GroupConfig, SpawnerConfig, SpawningConfig } from "./spawning.js";

const DT = 1 / 60;

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

/** A roll every 5 seconds, each sure to bring something, and no head start. */
const CERTAIN: SpawnerConfig = {
  period: 5,
  nothing: 0,
  certainAfter: 20,
  headStart: 0,
};

/** Zombies alone, one at a time, never within 1100px of a player. */
const ZOMBIES: SpawningConfig = {
  weight: 1,
  tries: 24,
  unseenDistance: 1100,
};

// Rolls, picks and spawn spots draw from Math.random; every test here runs on a fixed seed so
// counts and timings hold.
beforeEach(() => {
  vi.spyOn(Math, "random").mockImplementation(mulberry32(1));
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Tuning {
  readonly spawner?: SpawnerConfig;
  readonly zombie?: SpawningConfig;
  readonly exploder?: SpawningConfig;
  readonly sim?: SimConfig;
  readonly kind?: WorldKind;
}

/**
 * A new world with its cruiser and no scattered zombies, blind ones so none runs at the player,
 * its spawner and kinds tuned by `tuning`; zombies alone may come unless it says otherwise.
 */
function world(tuning: Tuning = {}): Session {
  const zombie = omit(testEntitiesConfig.zombie, "spawn");
  const entities: EntitiesConfig = {
    ...testEntitiesConfig,
    spawner: tuning.spawner ?? CERTAIN,
    zombie: { ...zombie, sightRange: 0, spawning: tuning.zombie ?? ZOMBIES },
    exploder: {
      ...testEntitiesConfig.exploder,
      senseRange: 0,
      ...(tuning.exploder !== undefined && { spawning: tuning.exploder }),
    },
  };
  const game = createSession(
    "me",
    "ME",
    "SPAWNS",
    tuning.kind ?? "standard",
    testSfx(),
    tuning.sim ?? testSimConfig,
  );
  registerContent(game, entityContent(entities));
  for (const content of game.contents) content.populate(game);
  return game;
}

/** A monster spawned: its kind, when, and how far it was from the nearest player. */
interface Spawned {
  readonly kind: string;
  readonly time: number;
  readonly distance: number;
}

function kindName(game: Session, id: number): string {
  for (const [name, kind] of game.kindIds) if (kind === id) return name;
  return "?";
}

/** Runs `seconds` standing still, returning each zombie or exploder that spawned meanwhile. */
function play(game: Session, seconds: number): Spawned[] {
  const known = new Set(game.entities.keys());
  const spawned: Spawned[] = [];
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, still, DT);
    for (const entity of game.entities.values()) {
      if (known.has(entity.id)) continue;
      known.add(entity.id);
      const kind = kindName(game, entity.kind);
      if (kind !== "zombie" && kind !== "exploder") continue;
      const distances = [...game.players.values()].map((player) =>
        Math.hypot(player.x - entity.x, player.y - entity.y),
      );
      spawned.push({
        kind,
        time: game.worldTime,
        distance: Math.min(...distances),
      });
    }
  }
  return spawned;
}

function count(game: Session, name: string): number {
  const kind = game.kindIds.get(name);
  return [...game.entities.values()].filter((entity) => entity.kind === kind)
    .length;
}

test("the chance of nothing falls evenly from its start to none, then stays none", () => {
  const config = { ...CERTAIN, nothing: 0.6, certainAfter: 100 };
  expect(nothingChance(config, 0)).toBeCloseTo(0.6);
  expect(nothingChance(config, 50)).toBeCloseTo(0.3);
  expect(nothingChance(config, 100)).toBe(0);
  expect(nothingChance(config, 1000)).toBe(0);
});

test("the spawner rolls once a period, and a sure roll always brings something", () => {
  const game = world();
  expect(play(game, CERTAIN.period - 0.1)).toEqual([]);
  expect(play(game, 0.2)).toHaveLength(1);
  expect(play(game, CERTAIN.period * 4)).toHaveLength(4);
});

test("a roll may bring nothing while the world is young, never once it is old enough", () => {
  const spawner = { ...CERTAIN, nothing: 1, certainAfter: 60 };
  const game = world({ spawner });
  const early = play(game, 20);
  // Each roll in the first 20 seconds brings nothing at least two times in three.
  expect(early.length).toBeLessThan(4);
  play(game, 40);
  // A roll may still find nowhere to put its zombie.
  expect(play(game, CERTAIN.period * 10).length).toBeGreaterThanOrEqual(9);
});

test("a kind with no weight never comes", () => {
  const game = world({ zombie: { ...ZOMBIES, weight: 0 } });
  expect(play(game, 60)).toEqual([]);
});

test("kinds come in proportion to their weights", () => {
  // A head start of 200 sure rolls, so no step of the world need be run.
  const game = world({
    spawner: { ...CERTAIN, period: 1, headStart: 200 },
    zombie: { ...ZOMBIES, weight: 3 },
    exploder: { ...ZOMBIES, weight: 1 },
  });
  const zombies = count(game, "zombie");
  const exploders = count(game, "exploder");
  expect(zombies + exploders).toBeGreaterThan(150);
  expect(zombies / exploders).toBeGreaterThan(2);
  expect(zombies / exploders).toBeLessThan(4.5);
});

test("a kind whose time has not come is left out of the picks", () => {
  const game = world({
    zombie: { ...ZOMBIES, weight: 1 },
    exploder: { ...ZOMBIES, weight: 1000, after: 30 },
  });
  const early = play(game, 29);
  expect(early.length).toBeGreaterThan(3);
  expect(early.every(({ kind }) => kind === "zombie")).toBe(true);
  const late = play(game, 30);
  expect(late.filter(({ kind }) => kind === "exploder").length).toBeGreaterThan(
    3,
  );
});

test("a kind with a most comes no more while that many are about, groups stopping short of it", () => {
  // A head start of 50 sure rolls, so no step of the world need be run.
  const game = world({
    spawner: { ...CERTAIN, period: 1, headStart: 50 },
    zombie: {
      ...ZOMBIES,
      weight: 1000,
      most: 4,
      group: { min: 3, max: 3, spread: 100 },
    },
    exploder: { ...ZOMBIES, weight: 1 },
  });
  expect(count(game, "zombie")).toBe(4);
  expect(count(game, "exploder")).toBeGreaterThan(40);
});

test("a kind with nowhere to appear gives way to another", () => {
  const game = world({
    zombie: { ...ZOMBIES, weight: 1000, unseenDistance: 1_000_000 },
    exploder: { ...ZOMBIES, weight: 1 },
  });
  const spawned = play(game, CERTAIN.period * 5 + 0.1);
  expect(spawned).toHaveLength(5);
  expect(spawned.every(({ kind }) => kind === "exploder")).toBe(true);
});

test("a spot's share kept apart is its distance to the nearest body of the kinds, past touching, over the distance", () => {
  const game = world();
  const apart = { from: ["snail"], distance: 400 };
  const at = { x: 1000, y: 1000 };
  expect(apartShare(game, at, apart)).toBe(1);
  expect(apartShare(game, at, undefined)).toBe(1);
  const snail = spawnEntity(game, "snail", 1200, 1000, freshSnail(null, 0));
  expect(apartShare(game, at, apart)).toBeCloseTo((200 - snail.radius) / 400);
  expect(apartShare(game, snail, apart)).toBe(0);
  // Bodies of kinds it does not keep from count for nothing.
  expect(apartShare(game, at, { ...apart, from: ["exploder"] })).toBe(1);
});

/** The mean distance from each of `game`'s zombies to its nearest other. */
function meanSpacing(game: Session): number {
  const kind = game.kindIds.get("zombie");
  const zombies = [...game.entities.values()].filter((e) => e.kind === kind);
  return mean(
    zombies.map((zombie) =>
      Math.min(
        ...zombies
          .filter((other) => other !== zombie)
          .map((other) => Math.hypot(other.x - zombie.x, other.y - zombie.y)),
      ),
    ),
  );
}

test("a kind kept apart from its own kind arrives farther from the rest of it", () => {
  const spawner = { ...CERTAIN, period: 1, headStart: 20 };
  const near = world({ spawner });
  const apart = world({
    spawner,
    zombie: {
      ...ZOMBIES,
      apart: { from: ["zombie"], distance: testSimConfig.world.cell * 40 },
    },
  });
  expect(count(apart, "zombie")).toBe(20);
  expect(meanSpacing(apart)).toBeGreaterThan(meanSpacing(near) * 1.2);
});

test("a new world starts with its head start of rolls, each at the chance it begins with", () => {
  const sure = world({ spawner: { ...CERTAIN, headStart: 30 } });
  expect(count(sure, "zombie")).toBe(30 / CERTAIN.period);
  // Rolls 20 minutes on would be sure to bring something; the head start's are not.
  const never = world({
    spawner: { ...CERTAIN, nothing: 1, certainAfter: 1, headStart: 30 },
  });
  expect(count(never, "zombie")).toBe(0);
});

test("a new world's head start brings no kind whose time has not come", () => {
  const game = world({
    spawner: { ...CERTAIN, headStart: 60 },
    zombie: { ...ZOMBIES, after: 1 },
  });
  expect(count(game, "zombie")).toBe(0);
});

test("a new world's head start keeps out of every player's sight, and out of the start", () => {
  // Tries enough that a spot out of sight is found, rather than falling back to the farthest tried.
  const game = world({
    spawner: { ...CERTAIN, headStart: 60 },
    zombie: { ...ZOMBIES, tries: 100 },
  });
  const kind = game.kindIds.get("zombie");
  const spawned = [...game.entities.values()].filter((e) => e.kind === kind);
  expect(spawned).toHaveLength(12);
  for (const zombie of spawned) {
    expect(inRect(game.world.layout.start, zombie)).toBe(false);
    expect(
      Math.hypot(zombie.x - game.local.x, zombie.y - game.local.y),
    ).toBeGreaterThanOrEqual(ZOMBIES.unseenDistance);
  }
});

test("the dev square, too small to hide in, still starts with some, as far as they can stand", () => {
  const game = world({ spawner: { ...CERTAIN, headStart: 30 }, kind: "dev" });
  expect(count(game, "zombie")).toBeGreaterThan(0);
  expect(play(game, CERTAIN.period * 3)).toEqual([]);
});

test("no spawn comes within the unseen distance of any player", () => {
  const game = world();
  const other = createPlayer(
    "other",
    "OTHER",
    randomFreePosition(game.world, 14, mulberry32(5)),
    testSimConfig,
  );
  game.players.set(other.id, other);
  const spawned = play(game, CERTAIN.period * 15 + 0.1);
  expect(spawned.length).toBeGreaterThan(10);
  for (const { distance } of spawned)
    expect(distance).toBeGreaterThanOrEqual(ZOMBIES.unseenDistance);
});

test("only the host spawns", () => {
  const game = world();
  game.hosting = false;
  expect(play(game, 60)).toEqual([]);
});

const GROUP_OF_FIVE: SpawningConfig = {
  ...ZOMBIES,
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
  const game = world({ zombie: GROUP_OF_FIVE });
  const spawned = play(game, CERTAIN.period + 0.1);
  expect(spawned).toHaveLength(5);
  expect(new Set(spawned.map(({ time }) => time)).size).toBe(1);
  for (const { distance } of spawned)
    expect(distance).toBeGreaterThanOrEqual(ZOMBIES.unseenDistance);
  const points = zombiePoints(game);
  const [first] = points;
  for (const [index, point] of points.entries()) {
    expect(
      Math.hypot(point.x - (first?.x ?? 0), point.y - (first?.y ?? 0)),
    ).toBeLessThanOrEqual(100 + 10);
    for (const other of points.slice(index + 1))
      expect(
        Math.hypot(point.x - other.x, point.y - other.y),
      ).toBeGreaterThanOrEqual(testEntitiesConfig.zombie.radius * 2 - 10);
  }
});

test("groups come in sizes between the least and the most", () => {
  const game = world({
    spawner: { ...CERTAIN, period: 0.5 },
    zombie: { ...ZOMBIES, group: { min: 1, max: 5, spread: 100 } },
  });
  const sizes = new Map<number, number>();
  for (const { time } of play(game, 10))
    sizes.set(time, (sizes.get(time) ?? 0) + 1);
  const counts = [...sizes.values()];
  expect(counts.length).toBeGreaterThan(10);
  for (const size of counts) {
    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(5);
  }
  expect(new Set(counts).size).toBeGreaterThan(1);
});

test("a growing group's size moves evenly from its start to its end, then holds", () => {
  const group: GroupConfig = {
    min: 1,
    max: 5,
    spread: 100,
    grows: { min: 5, max: 11, by: 100 },
  };
  expect(groupRange(group, 0)).toEqual({ min: 1, max: 5 });
  expect(groupRange(group, 50)).toEqual({ min: 3, max: 8 });
  expect(groupRange(group, 100)).toEqual({ min: 5, max: 11 });
  expect(groupRange(group, 1000)).toEqual({ min: 5, max: 11 });
  const sizes = (time: number) =>
    Array.from({ length: 4000 }, () => groupSize(group, time));
  expect(mean(sizes(0))).toBeCloseTo(3, 0);
  expect(mean(sizes(50))).toBeCloseTo(5.5, 0);
  expect(mean(sizes(100))).toBeCloseTo(8, 0);
  for (const size of sizes(100)) {
    expect(size).toBeGreaterThanOrEqual(5);
    expect(size).toBeLessThanOrEqual(11);
  }
  const fixed: GroupConfig = { min: 2, max: 2, spread: 100 };
  expect(groupSize(fixed, 1000)).toBe(2);
});

test("the spawner's groups grow as the world ages", () => {
  // Groups of one at the start, of four from 20 seconds in. Stepping one world through all 25
  // seconds piles up over a hundred zombies and runs slow, so the old world's clock starts at 20
  // instead: the spawner reads the world's age, however it got there.
  const groups = (age: number, seconds: number) => {
    const game = world({
      spawner: { ...CERTAIN, period: 0.5 },
      zombie: {
        ...ZOMBIES,
        group: {
          min: 1,
          max: 1,
          spread: 100,
          grows: { min: 4, max: 4, by: 20 },
        },
      },
    });
    game.worldTime = age;
    const sizes = new Map<number, number>();
    for (const { time } of play(game, seconds))
      sizes.set(time, (sizes.get(time) ?? 0) + 1);
    return [...sizes];
  };
  const early = groups(0, 2).filter(([time]) => time < 2);
  const late = groups(20, 5).filter(([time]) => time >= 20);
  expect(early.length).toBeGreaterThan(0);
  expect(late.length).toBeGreaterThan(5);
  expect(mean(early.map(([, size]) => size))).toBeLessThan(1.5);
  expect(mean(late.map(([, size]) => size))).toBeGreaterThan(3.5);
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

test("spawns favour dangerous spots: far from the road, and towards the exit's side", () => {
  const seeded = (danger: DangerConfig) => {
    vi.spyOn(Math, "random").mockImplementation(mulberry32(11));
    // A head start of 100 rolls, so each stands where it spawned; more tries than the test
    // zombie's, so the weighing shows over the noise.
    const game = world({
      spawner: { ...CERTAIN, period: 1, headStart: 100 },
      zombie: { ...ZOMBIES, tries: 64 },
      sim: dangerous(danger),
    });
    vi.restoreAllMocks();
    const spots = zombiePoints(game).map((at) => remoteness(game.world, at));
    return {
      count: spots.length,
      road: mean(spots.map(({ road }) => road)),
      across: mean(spots.map(({ across }) => across)),
    };
  };
  const even = seeded({ road: 0, right: 0, exit: 0, reach: 0 });
  const far = seeded({ road: 20, right: 0, exit: 0, reach: 0 });
  const right = seeded({ road: 0, right: 20, exit: 0, reach: 0 });

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
  // In the middle column, well short of the exit, which is dark.
  const middle = game.world.W / 2;
  const { cell } = game.world.map;
  const road = cellWhere(
    game,
    AREA.road,
    (at) => at.x >= middle && at.x < middle + cell,
  );
  expect(isLit(game, road)).toBe(true);
  expect(spawnAllowed(game, road)).toBe(false);
  expect(spawnWeight(game, road)).toBe(0);
  const litRoom = cellWhere(game, AREA.room, (at) => isLit(game, at));
  expect(spawnAllowed(game, litRoom)).toBe(false);
});

test("a kind whose rules allow light may appear in the sunlit road, but still not in the start", () => {
  const game = world();
  const rules = { inLight: true };
  const middle = { x: game.world.W / 2, y: game.world.H / 2 };
  const road = cellWhere(game, AREA.road, (at) => at.x >= middle.x);
  expect(spawnAllowed(game, road, rules)).toBe(true);
  expect(spawnWeight(game, road, rules)).toBe(dangerWeight(game.world, road));
  const { start } = game.world.layout;
  const inStart = { x: start.x + start.w / 2, y: start.y + start.h / 2 };
  expect(spawnAllowed(game, inStart, rules)).toBe(false);
});

test("zombies a new world scatters favour the same spots", () => {
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
  expect(
    mean(first({ road: 0, right: 20, exit: 0, reach: 0 })),
  ).toBeGreaterThan(
    mean(first({ road: 0, right: 0, exit: 0, reach: 0 })) + 0.08,
  );
});

test("the road round the exit is dark, and the most dangerous place to spawn, past the corners on the right", () => {
  const game = world();
  const { exit } = game.world.layout;
  const atExit = cellWhere(game, AREA.road, (at) => inRect(exit, at));
  expect(isLit(game, atExit)).toBe(false);
  expect(spawnAllowed(game, atExit)).toBe(true);
  const { W, H } = game.world;
  const corners = [
    { x: W - 1, y: 1 },
    { x: W - 1, y: H - 1 },
  ];
  for (const corner of corners)
    expect(spawnWeight(game, atExit)).toBeGreaterThan(
      dangerWeight(game.world, corner),
    );
});

/** `count` points the spawner picks for one of `kind` arriving in `game`, those it finds. */
function arrivalPoints(game: Session, kind: string, count: number): Point[] {
  return Array.from({ length: count }, () => arrivalPoint(game, kind)).filter(
    (at) => at !== null,
  );
}

/** A cell of the road in the exit, dark and the most dangerous place there is. */
function exitRoad(game: Session): Point {
  const { exit } = game.world.layout;
  return cellWhere(game, AREA.road, (at) => inRect(exit, at));
}

test("a spawner that keeps off the road brings nothing onto it, not even the dark road at the exit", () => {
  const open = world();
  const onRoad = arrivalPoints(open, "zombie", 200).filter(
    (at) => roadDistanceAt(open.world, at) === 0,
  );
  // Left free, the exit's dark road draws some.
  expect(onRoad.length).toBeGreaterThan(0);
  // A head start of 100 sure rolls, every zombie still where it arrived.
  const game = world({ spawner: { ...CERTAIN, offRoad: 1, headStart: 100 } });
  expect(spawnWeight(game, exitRoad(game))).toBe(0);
  const kind = game.kindIds.get("zombie");
  const arrived = [...game.entities.values()].filter(
    (entity) => entity.kind === kind,
  );
  expect(arrived.length).toBeGreaterThan(10);
  for (const entity of arrived)
    expect(roadDistanceAt(game.world, entity)).toBeGreaterThanOrEqual(1);
  const { radius } = testEntitiesConfig.zombie;
  const points = arrivalPoints(game, "zombie", 200);
  expect(points.length).toBeGreaterThan(100);
  for (const at of points) {
    expect(roadDistanceAt(game.world, at)).toBeGreaterThanOrEqual(1);
    expect(isAreaFree(game.world.map, at.x, at.y, radius)).toBe(true);
  }
});

test("a world without a road, as the dev square, has none to keep off", () => {
  const game = world({
    spawner: { ...CERTAIN, offRoad: 1, headStart: 30 },
    kind: "dev",
  });
  expect(count(game, "zombie")).toBeGreaterThan(0);
});

test("a kind's own off-road rule overrides the spawner's", () => {
  const game = world({ spawner: { ...CERTAIN, offRoad: 1 } });
  expect(spawnWeight(game, exitRoad(game), { offRoad: 0 })).toBeGreaterThan(0);
});

test("a monster left alone relocates only where it could spawn: free, dark, off the road and unseen", () => {
  const game = world({ spawner: { ...CERTAIN, offRoad: 1 } });
  const from = exitRoad(game);
  const peeper = spawnEntity(game, "peeper", from.x, from.y, freshPeeper(0));
  const blink: Sound = { url: "test/relocate-blink.mp3", range: 0 };
  // No wait and no range, so it tries to move every call.
  const restless = { after: 0, range: 0, retry: 0 };
  const { peeper: hunting } = testEntitiesConfig;
  let moves = 0;
  for (let i = 0; i < 100; i++) {
    const { moved } = relocate(
      game,
      "peeper",
      peeper,
      0,
      hunting,
      restless,
      blink,
    );
    if (!moved) continue;
    moves++;
    expect(roadDistanceAt(game.world, peeper)).toBeGreaterThanOrEqual(1);
    expect(isAreaFree(game.world.map, peeper.x, peeper.y, peeper.radius)).toBe(
      true,
    );
    expect(spawnAllowed(game, peeper, { offRoad: 1 })).toBe(true);
    expect(watchedAt(game, "peeper", peeper)).toBe(false);
  }
  expect(moves).toBeGreaterThan(50);
});

/** A box of cells: its top-left cell and its side. */
interface Box {
  readonly col: number;
  readonly row: number;
  readonly side: number;
}

/**
 * The first box of `side` cells in the right half of `game`'s world, away from the start, whose
 * cells are all `far` or more from the road.
 */
function farBox(game: Session, side: number, far: number): Box {
  const { cols, rows } = game.world.map;
  const { roadDistance } = game.world.layout;
  const clear = (col: number, row: number): boolean => {
    for (let r = row; r < row + side; r++)
      for (let c = col; c < col + side; c++)
        if ((roadDistance[r * cols + c] ?? 0) < far) return false;
    return true;
  };
  for (let row = 0; row + side <= rows; row++)
    for (let col = Math.floor(cols / 2); col + side <= cols; col++)
      if (clear(col, row)) return { col, row, side };
  throw new Error("no box that far from the road");
}

/** Walls `box` round in `game`, its inside cleared to open floor: a pocket cut off from all. */
function wallIn(game: Session, box: Box): void {
  const { map, layout } = game.world;
  const last = box.side - 1;
  for (let r = 0; r <= last; r++)
    for (let c = 0; c <= last; c++) {
      const index = (box.row + r) * map.cols + box.col + c;
      const ring = r === 0 || c === 0 || r === last || c === last;
      map.solid[index] = ring ? 1 : 0;
      layout.area[index] = ring ? AREA.wall : AREA.room;
    }
}

/** Whether `at` lies in `box`, its ring included. */
function inBox(game: Session, box: Box, at: Point): boolean {
  const { cell } = game.world.map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  return (
    col >= box.col &&
    row >= box.row &&
    col < box.col + box.side &&
    row < box.row + box.side
  );
}

/** The rows, first and last, of a way from `box` straight to the road beside it, up or down. */
function wayToRoad(game: Session, box: Box): { from: number; to: number } {
  const { map, layout } = game.world;
  const roadRow = (step: number): number | null => {
    const first = step < 0 ? box.row - 1 : box.row + box.side;
    for (let row = first; row >= 0 && row < map.rows; row += step)
      if (layout.area[row * map.cols + box.col + 1] === AREA.road) return row;
    return null;
  };
  const above = roadRow(-1);
  if (above !== null) return { from: above + 1, to: box.row + box.side - 2 };
  const below = roadRow(1);
  if (below === null) throw new Error("no road above or below the box");
  return { from: box.row + 1, to: below - 1 };
}

/** Knocks down every wall in the columns `cols` of the rows `rows` of `game`. */
function knockThrough(
  game: Session,
  rows: { from: number; to: number },
  cols: { from: number; to: number },
): void {
  const { cell } = game.world.map;
  for (let row = rows.from; row <= rows.to; row++)
    for (let col = cols.from; col <= cols.to; col++)
      destroyWalls(game, {
        center: { x: (col + 0.5) * cell, y: (row + 0.5) * cell },
        radius: 1,
        shape: "square",
      });
}

test("a blind dog never appears shut in where it is too big to walk to the road", () => {
  const game = world({ spawner: { ...CERTAIN, offRoad: 1 } });
  const { radius } = testEntitiesConfig.blindDog;
  const { map } = game.world;
  const box = farBox(game, spanOf(map.cell, radius) + 8, 2);
  wallIn(game, box);
  const middle = {
    x: (box.col + box.side / 2) * map.cell,
    y: (box.row + box.side / 2) * map.cell,
  };
  expect(spawnAllowed(game, middle, { inLight: true }, radius)).toBe(true);
  expect(
    spawnAllowed(game, middle, { inLight: true, reachesRoad: true }, radius),
  ).toBe(false);
  const points = arrivalPoints(game, "blindDog", 300);
  expect(points.length).toBeGreaterThan(100);
  for (const at of points) {
    expect(inBox(game, box, at)).toBe(false);
    expect(reachesRoad(game, at, radius)).toBe(true);
  }
});

test("a pocket opens to a body once walls come down to make a way to the road wide enough for it", () => {
  const { radius } = testEntitiesConfig.blindDog;
  const rules = { inLight: true, reachesRoad: true };
  /** A world with a pocket and a way `wide` cells wide knocked from it to the road. */
  const pocketed = (wide: number): { game: Session; middle: Point } => {
    const game = world();
    const { cell } = game.world.map;
    const box = farBox(game, spanOf(cell, radius) + 8, 2);
    wallIn(game, box);
    const middle = {
      x: (box.col + box.side / 2) * cell,
      y: (box.row + box.side / 2) * cell,
    };
    // Found shut in first, so the knocking through must be noticed.
    expect(spawnAllowed(game, middle, rules, radius)).toBe(false);
    knockThrough(game, wayToRoad(game, box), {
      from: box.col + 1,
      to: box.col + wide,
    });
    return { game, middle };
  };
  const span = spanOf(testSimConfig.world.cell, radius);
  const wide = pocketed(span);
  expect(spawnAllowed(wide.game, wide.middle, rules, radius)).toBe(true);
  const narrow = pocketed(span - 1);
  expect(spawnAllowed(narrow.game, narrow.middle, rules, radius)).toBe(false);
  const small = testSimConfig.world.cell / 2 - 1;
  expect(spawnAllowed(narrow.game, narrow.middle, rules, small)).toBe(true);
});

test("a world without a road, as the dev square, has none a kind must reach", () => {
  const game = world({ kind: "dev" });
  const { radius } = testEntitiesConfig.blindDog;
  const rules = { inLight: true, reachesRoad: true };
  expect(spawnAllowed(game, { x: 450, y: 300 }, rules, radius)).toBe(true);
});
