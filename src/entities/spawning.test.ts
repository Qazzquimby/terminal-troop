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
  dangerWeight,
  inRect,
  isLit,
  mulberry32,
  randomFreePosition,
  registerContent,
  remoteness,
  updateSession,
} from "../sim/index.js";
import type {
  Controls,
  DangerConfig,
  Session,
  SimConfig,
  WorldKind,
} from "../sim/index.js";
import type { EntitiesConfig } from "./index.js";
import { entityContent } from "./index.js";
import { spawnAllowed } from "./spawn-rules.js";
import {
  groupRange,
  groupSize,
  nothingChance,
  spawnWeight,
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

test("a kind with nowhere to appear gives way to another", () => {
  const game = world({
    zombie: { ...ZOMBIES, weight: 1000, unseenDistance: 1_000_000 },
    exploder: { ...ZOMBIES, weight: 1 },
  });
  const spawned = play(game, CERTAIN.period * 5 + 0.1);
  expect(spawned).toHaveLength(5);
  expect(spawned.every(({ kind }) => kind === "exploder")).toBe(true);
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
  const sizes = new Map<number, number>();
  for (const { time } of play(game, 25))
    sizes.set(time, (sizes.get(time) ?? 0) + 1);
  const early = [...sizes].filter(([time]) => time < 2);
  const late = [...sizes].filter(([time]) => time >= 20);
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
