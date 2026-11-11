import { describe, expect, test } from "vitest";
import {
  testMapMemoryConfig as config,
  testSfx,
  testSimConfig,
} from "../integration/sim-config.js";
import { createSession, litWalls, visibilityPolygon } from "../sim/index.js";
import type { Point, TileMap, VisionSource } from "../sim/index.js";
import { createMapMemory, mapMemoryKey } from "./map-memory.js";
import type {
  Area,
  MapMemory,
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
const here: MapPlace = { room: "ROOM1", world: "dev", seed: 1 };

/** Storage held in a map, counting writes. */
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
      this.writes++;
      saved.set(key, value);
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
    .within(everywhere)
    .floor.some(({ x, y }) => x === col * CELL && y === row * CELL);
}

function entered(storage: MapMemoryStorage = memoryStorage()): MapMemory {
  const memory = createMapMemory(config, storage);
  memory.enter(here, map);
  return memory;
}

describe("marking", () => {
  test("remembers the floor a source sees and lights, not what a wall hides", () => {
    const memory = entered();
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);

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
    memory.see({ seen: near.seen, lit: far.lit, walls: new Map() }, everywhere);

    expect(memory.within(everywhere).floor).toEqual([]);
  });

  test("only floor within the view is marked", () => {
    const memory = entered();
    memory.see(sightFrom({ x: 125, y: 375 }), {
      x: 0,
      y: 0,
      width: 200,
      height: 600,
    });

    expect(remembers(memory, 3, 7)).toBe(true);
    expect(remembers(memory, 5, 7)).toBe(false);
  });

  test("a remembered wall shows the faces looking onto remembered floor", () => {
    const memory = entered();
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);

    const { walls } = memory.within(everywhere);
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
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);
    expect(memory.within(everywhere)).toEqual({ floor: [], walls: new Map() });
  });
});

describe("persistence", () => {
  test("what was saved for a world comes back on entering it again", () => {
    const storage = memoryStorage();
    const first = entered(storage);
    first.see(sightFrom({ x: 125, y: 75 }), everywhere);
    first.flush();

    const again = entered(storage);

    expect(again.within(everywhere)).toEqual(first.within(everywhere));
    expect(remembers(again, 3, 1)).toBe(true);
    expect([...storage.saved.keys()]).toEqual([mapMemoryKey(here, map)]);
  });

  test.each([
    ["room", { ...here, room: "ROOM2" }],
    ["world kind", { ...here, world: "standard" as const }],
    ["seed", { ...here, seed: 2 }],
  ])("entering a world with another %s starts from nothing", (_, other) => {
    const storage = memoryStorage();
    const memory = entered(storage);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);

    memory.enter(other, map);
    expect(memory.within(everywhere).floor).toEqual([]);

    memory.enter(here, map);
    expect(remembers(memory, 3, 1)).toBe(true);
  });

  test("saves at most once a save interval, and only when something new was seen", () => {
    const storage = memoryStorage();
    const memory = entered(storage);

    memory.save(0);
    expect(storage.writes).toBe(0);

    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);
    memory.save(100);
    memory.see(sightFrom({ x: 625, y: 375 }), everywhere);
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
    expect(entered(storage).within(everywhere).floor).toEqual([]);
  });

  test("failing storage leaves memory working for the visit", () => {
    const broken: MapMemoryStorage = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("full");
      },
    };
    const memory = entered(broken);
    memory.see(sightFrom({ x: 125, y: 75 }), everywhere);

    expect(() => {
      memory.save(10_000);
      memory.flush();
    }).not.toThrow();
    expect(remembers(memory, 3, 1)).toBe(true);
  });
});
