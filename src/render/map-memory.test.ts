import { describe, expect, test } from "vitest";
import {
  testMapMemoryConfig as config,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession, litWalls, visibilityPolygon } from "../sim/index.js";
import type { Point, TileMap, VisionSource } from "../sim/index.js";
import {
  MAP_MEMORY_INDEX,
  createMapMemory,
  mapMemoryKey,
} from "./map-memory.js";
import type {
  Area,
  MapMemory,
  MapMemoryConfig,
  MapMemoryStorage,
  MapPlace,
  Sight,
} from "./map-memory.js";

const CELL = testSimConfig.world.cell;
const RAYS = 360;

/** The dev square: 18 by 12 cells, with a pillar over cells (4..5, 1..2) and (12..13, 9..10). */
function devMap(): TileMap {
  return createSession("me", "ME", "MEMORY", "dev", testSfx(), testSimConfig)
    .world.map;
}

const map = devMap();
const everywhere: Area = { x: 0, y: 0, width: 900, height: 600 };
/** Where the viewer stands, as fading measures from: where the tests see from. */
const viewer: Point = { x: 125, y: 75 };
const here: MapPlace = { room: "ROOM1", world: "dev", seed: 1 };

/** Storage held in a map, counting writes of remembered terrain. */
function memoryStorage(): MapMemoryStorage & {
  readonly saved: Map<string, string>;
  writes: number;
} {
  const saved = new Map<string, string>();
  return {
    saved,
    writes: 0,
    get: (key) => saved.get(key) ?? null,
    set(key, value) {
      if (key !== MAP_MEMORY_INDEX) this.writes++;
      saved.set(key, value);
    },
    remove: (key) => {
      saved.delete(key);
    },
  };
}

/** What a source at `at` sees and lights, `range` px round it. */
function sightFrom(at: Point, range = 400): Sight {
  const source: VisionSource = { ...at, range };
  const seen = [visibilityPolygon(map, source, RAYS)];
  const lit = [visibilityPolygon(map, source, RAYS)];
  return { seen, lit, walls: litWalls(seen, lit) };
}

const cellAt = (col: number, row: number): Point => ({
  x: col * CELL,
  y: row * CELL,
});

function remembers(memory: MapMemory, col: number, row: number): boolean {
  return memory
    .within(everywhere, 0, viewer)
    .floor.some(({ x, y }) => x === col * CELL && y === row * CELL);
}

/** The test config with remembered terrain that never fades. */
const lasting: MapMemoryConfig = {
  ...config,
  fade: { ...config.fade, seconds: 0 },
};

function entered(
  storage: MapMemoryStorage = memoryStorage(),
  tuning: MapMemoryConfig = config,
): MapMemory {
  const memory = createMapMemory(tuning, storage);
  memory.enter(here, map);
  return memory;
}

describe("marking", () => {
  test("remembers the floor a source sees and lights, not what a wall hides", () => {
    const memory = entered();
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);

    expect(remembers(memory, 2, 1)).toBe(true);
    expect(remembers(memory, 3, 1)).toBe(true);
    expect(remembers(memory, 3, 5)).toBe(true);
    expect(remembers(memory, 7, 1)).toBe(false);
    expect(remembers(memory, 4, 1)).toBe(false);
  });

  test("floor seen but unlit, or lit but unseen, is not remembered", () => {
    const memory = entered();
    const near = sightFrom({ x: 125, y: 375 }, 60);
    const far = sightFrom({ x: 625, y: 375 }, 60);
    memory.see(
      { seen: near.seen, lit: far.lit, walls: new Map() },
      everywhere,
      0,
    );

    expect(memory.within(everywhere, 0, viewer).floor).toEqual([]);
  });

  test("only floor within the view is marked", () => {
    const memory = entered();
    memory.see(
      sightFrom({ x: 125, y: 375 }),
      {
        x: 0,
        y: 0,
        width: 200,
        height: 600,
      },
      0,
    );

    expect(remembers(memory, 3, 7)).toBe(true);
    expect(remembers(memory, 5, 7)).toBe(false);
  });

  test("a remembered wall shows the faces looking onto remembered floor", () => {
    const memory = entered();
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);

    const { walls } = memory.within(everywhere, 0, viewer);
    const pillar = [...walls.values()].flat();

    expect(pillar).toContainEqual({
      from: cellAt(4, 1),
      to: cellAt(4, 2),
      normal: { x: -1, y: 0 },
    });
    expect(pillar).not.toContainEqual(
      expect.objectContaining({ from: cellAt(6, 1), to: cellAt(6, 2) }),
    );
  });

  test("nothing is remembered before entering a world", () => {
    const memory = createMapMemory(config, memoryStorage());
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    const { floor, walls } = memory.within(everywhere, 0, viewer);
    expect({ floor, walls }).toEqual({ floor: [], walls: new Map() });
  });
});

describe("fading", () => {
  const { seconds, spread } = config.fade;
  const seenFloor = (memory: MapMemory, now: number) =>
    memory.within(everywhere, now, viewer).floor.length;

  /** The test config fading every cell alike, by time out of sight, wherever the viewer is. */
  const timed: MapMemoryConfig = {
    ...config,
    fade: { ...config.fade, reach: 0 },
  };

  test("with no reach, terrain out of sight is all there until the first of it fades, and gone after `seconds`", () => {
    const memory = entered(memoryStorage(), timed);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    const all = seenFloor(memory, 0);

    expect(all).toBeGreaterThan(10);
    expect(seenFloor(memory, seconds * (1 - spread) * 1000 - 1)).toBe(all);
    expect(seenFloor(memory, seconds * 1000 - 1)).toBe(all);
    expect(seenFloor(memory, seconds * 1000)).toBe(0);
    expect(memory.within(everywhere, seconds * 1000, viewer).walls.size).toBe(
      0,
    );
  });

  test("with no reach, each cell's age over the view is how long since it was seen, Infinity where never", () => {
    const memory = entered(memoryStorage(), timed);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 1000);
    const { ages } = memory.within(everywhere, 3500, viewer);
    const at = (col: number, row: number) =>
      ages.ages[(row - ages.row) * ages.cols + (col - ages.col)];

    expect(at(3, 1)).toBeCloseTo(2.5);
    expect(at(7, 1)).toBe(Infinity);
  });

  test("terrain still in sight is renewed, at most once a refresh", () => {
    const memory = entered(memoryStorage(), timed);
    const sight = sightFrom({ x: 125, y: 75 });
    const refresh = config.fade.refresh * 1000;
    memory.see(sight, everywhere, 0);
    memory.see(sight, everywhere, refresh / 2);
    memory.see(sight, everywhere, refresh);

    const { ages } = memory.within(everywhere, refresh, viewer);
    expect(Math.min(...ages.ages)).toBe(0);
    // Renewed at `refresh`, not at half of it.
    expect(seenFloor(memory, seconds * 1000 + refresh / 2)).toBeGreaterThan(0);
    expect(seenFloor(memory, seconds * 1000 + refresh)).toBe(0);
  });

  /** How far, in cells, the floor cell with top-left corner `at` is from where the viewer stands. */
  const cellsFrom = (from: Point) => (at: Point) =>
    Math.hypot(at.x + CELL / 2 - from.x, at.y + CELL / 2 - from.y) / CELL;

  test("terrain fades from far to near: what is left is always nearer than what has gone", () => {
    const memory = entered();
    memory.see(sightFrom(viewer, 900), everywhere, 0);
    const distance = cellsFrom(viewer);
    const all = memory.within(everywhere, 0, viewer).floor;
    expect(all.length).toBeGreaterThan(30);

    let reach = Infinity;
    let thinned = false;
    for (let now = 500; now <= 30_000; now += 500) {
      const left = memory.within(everywhere, now, viewer).floor;
      const spot = ({ x, y }: Point) => `${String(x)},${String(y)}`;
      const kept = new Set(left.map(spot));
      const gone = all.filter((cell) => !kept.has(spot(cell)));
      const farthestLeft = Math.max(0, ...left.map(distance));
      // Every cell gone is farther than every cell left.
      for (const cell of gone)
        expect(distance(cell)).toBeGreaterThan(farthestLeft);
      // And the edge only ever creeps inward.
      expect(farthestLeft).toBeLessThanOrEqual(reach);
      reach = farthestLeft;
      thinned ||= gone.length > 0 && left.length > 0;
    }
    expect(thinned).toBe(true);
  });

  test("terrain `reach` cells away fades in `seconds`, twice as far in half that", () => {
    const { reach } = config.fade;
    const memory = entered();
    memory.see(sightFrom(viewer, 900), everywhere, 0);
    const distance = cellsFrom(viewer);
    const left = (now: number) =>
      memory.within(everywhere, now, viewer).floor.map(distance);

    expect(Math.max(...left((seconds * 1000) / 2))).toBeLessThan(reach * 2);
    expect(Math.max(...left((seconds * 1000) / 2))).toBeGreaterThan(reach);
    expect(Math.max(...left(seconds * 1000))).toBeLessThan(reach);
  });

  test("ink that has soaked away does not come back as the viewer nears it", () => {
    const memory = entered();
    memory.see(sightFrom(viewer, 900), everywhere, 0);
    const far = { x: 875, y: 575 };
    const before = memory.within(everywhere, 0, far).floor.length;
    const after = memory.within(everywhere, seconds * 1000, far).floor.length;
    expect(after).toBeLessThan(before);
    expect(
      memory.within(everywhere, seconds * 1000, viewer).floor,
    ).toHaveLength(after);
  });

  test("with `seconds` 0, remembered terrain never fades", () => {
    const memory = entered(memoryStorage(), lasting);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    expect(seenFloor(memory, 1e9)).toBe(seenFloor(memory, 0));
  });

  test("terrain saved on a past visit comes back already faded", () => {
    const storage = memoryStorage();
    const first = entered(storage);
    first.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    first.flush();

    expect(seenFloor(entered(storage), 0)).toBe(0);
    expect(seenFloor(entered(storage, lasting), 0)).toBeGreaterThan(10);
  });
});

describe("persistence", () => {
  test("what was saved for a world comes back on entering it again", () => {
    const storage = memoryStorage();
    const first = entered(storage, lasting);
    first.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    first.flush();

    const again = entered(storage, lasting);

    expect(again.within(everywhere, 0, viewer)).toEqual(
      first.within(everywhere, 0, viewer),
    );
    expect(remembers(again, 3, 1)).toBe(true);
    expect(storage.saved.has(mapMemoryKey(here, map))).toBe(true);
  });

  test.each([
    ["room", { ...here, room: "ROOM2" }],
    ["world kind", { ...here, world: "standard" as const }],
    ["seed", { ...here, seed: 2 }],
  ])("entering a world with another %s starts from nothing", (_, other) => {
    const storage = memoryStorage();
    const memory = entered(storage, lasting);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);

    memory.enter(other, map);
    expect(memory.within(everywhere, 0, viewer).floor).toEqual([]);

    memory.enter(here, map);
    expect(remembers(memory, 3, 1)).toBe(true);
  });

  test("saves at most once a save interval, and only when something new was seen", () => {
    const storage = memoryStorage();
    const memory = entered(storage);

    memory.save(0);
    expect(storage.writes).toBe(0);

    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    memory.save(100);
    memory.see(sightFrom({ x: 625, y: 375 }), everywhere, 0);
    memory.save(900);
    expect(storage.writes).toBe(1);

    memory.save(1100);
    expect(storage.writes).toBe(2);
    memory.save(5000);
    expect(storage.writes).toBe(2);
  });

  test("a save that doesn't fit the map is ignored", () => {
    const storage = memoryStorage();
    storage.saved.set(mapMemoryKey(here, map), btoa("short"));
    expect(entered(storage).within(everywhere, 0, viewer).floor).toEqual([]);
  });

  test("failing storage leaves memory working for the visit", () => {
    const broken: MapMemoryStorage = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("full");
      },
      remove: () => {
        throw new Error("denied");
      },
    };
    const memory = entered(broken);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);

    expect(() => {
      memory.save(10_000);
      memory.flush();
    }).not.toThrow();
    expect(remembers(memory, 3, 1)).toBe(true);
  });
});

describe("keeping only recent worlds", () => {
  const room = (n: number): MapPlace => ({ ...here, room: `ROOM${String(n)}` });
  const saved = (storage: ReturnType<typeof memoryStorage>, n: number) =>
    storage.saved.has(mapMemoryKey(room(n), map));

  /** Enters each room in turn, seeing something in each and saving it on leaving. */
  function visit(memory: MapMemory, rooms: readonly number[]): void {
    for (const n of rooms) {
      memory.enter(room(n), map);
      memory.see(sightFrom({ x: 125, y: 75 }), everywhere, 0);
    }
    memory.flush();
  }

  test("entering one more world than are kept deletes the one entered longest ago", () => {
    const storage = memoryStorage();
    const memory = createMapMemory(config, storage);
    visit(memory, [1, 2, 3]);
    expect([1, 2, 3].map((n) => saved(storage, n))).toEqual([true, true, true]);

    visit(memory, [4]);

    expect([1, 2, 3, 4].map((n) => saved(storage, n))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(JSON.parse(storage.saved.get(MAP_MEMORY_INDEX) ?? "")).toEqual([
      mapMemoryKey(room(4), map),
      mapMemoryKey(room(3), map),
      mapMemoryKey(room(2), map),
    ]);
  });

  test("entering an old world again makes it the most recent", () => {
    const storage = memoryStorage();
    const memory = createMapMemory(config, storage);
    visit(memory, [1, 2, 3, 1, 4]);

    expect([1, 2, 3, 4].map((n) => saved(storage, n))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  test.each([["not json {"], ['{"rooms": 3}'], ["[1, 2]"]])(
    "a corrupt index (%s) starts again",
    (corrupt) => {
      const storage = memoryStorage();
      storage.saved.set(MAP_MEMORY_INDEX, corrupt);
      const memory = createMapMemory(config, storage);

      expect(() => {
        visit(memory, [1]);
      }).not.toThrow();
      expect(JSON.parse(storage.saved.get(MAP_MEMORY_INDEX) ?? "")).toEqual([
        mapMemoryKey(room(1), map),
      ]);
      expect(saved(storage, 1)).toBe(true);
    },
  );
});
