import { describe, expect, test } from "vitest";
import { testGeneration, testSimConfig } from "../integration/sim-config.js";
import { buildWorld } from "./generation.js";
import {
  AREA,
  areaAt,
  danger,
  dangerWeight,
  isAreaFree,
  isOutdoors,
  mulberry32,
  remoteness,
  roomAt,
} from "./map.js";
import type { World, WorldConfig } from "./map.js";

/** A world the game's size: a road 8 to 24 wide, wider yards, rooms up to 9 across. */
const FULL_SIZE: WorldConfig = {
  ...testSimConfig.world,
  cols: 140,
  rows: 80,
  generation: {
    ...testGeneration,
    road: { width: { min: 8, max: 24 }, step: 16, meander: 8, margin: 18 },
    yard: { ...testGeneration.yard, depth: { min: 3, max: 7 } },
    rooms: { ...testGeneration.rooms, size: { min: 3, max: 9 } },
    start: 6,
    exit: 8,
  },
};

const WORLDS: readonly (readonly [string, WorldConfig])[] = [
  ["a full-size", FULL_SIZE],
  ["the tests'", testSimConfig.world],
];
const SEEDS = [1, 2, 3, 4, 5];

function build(world: WorldConfig, seed: number): World {
  return buildWorld(world, mulberry32(seed));
}

/** The open cells reachable from `start`, 4-connected. */
function reachable(world: World, start: number): Uint8Array {
  const { cols, solid } = world.map;
  const seen = new Uint8Array(solid.length);
  const stack = [start];
  seen[start] = 1;
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    const col = i % cols;
    for (const n of [
      col > 0 ? i - 1 : -1,
      col < cols - 1 ? i + 1 : -1,
      i - cols,
      i + cols,
    ]) {
      if (n < 0 || n >= solid.length || seen[n] === 1 || solid[n] === 1)
        continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return seen;
}

/** The cell index at the middle of `rect`, a box in pixels. */
function middleCell(world: World, rect: World["layout"]["start"]): number {
  const { cell, cols } = world.map;
  const col = Math.floor((rect.x + rect.w / 2) / cell);
  const row = Math.floor((rect.y + rect.h / 2) / cell);
  return row * cols + col;
}

/** Each column's road cells: how many, and whether they run unbroken. */
function roadColumns(world: World): { width: number; unbroken: boolean }[] {
  const { cols, rows } = world.map;
  return Array.from({ length: cols }, (_, col) => {
    const roadRows: number[] = [];
    for (let row = 0; row < rows; row++)
      if (world.layout.area[row * cols + col] === AREA.road) roadRows.push(row);
    const first = roadRows[0] ?? 0;
    const last = roadRows.at(-1) ?? -1;
    return {
      width: roadRows.length,
      unbroken: last - first + 1 === roadRows.length,
    };
  });
}

/**
 * Each room's neighbours through its doors: other rooms by id, outdoors as -1. A door cell has
 * open floor either side of it along one axis.
 */
function roomLinks(world: World): Map<number, Set<number>> {
  const { cols, rows } = world.map;
  const { area, room } = world.layout;
  const links = new Map<number, Set<number>>();
  const side = (i: number): number | null => {
    if (area[i] === AREA.room) return room[i] ?? null;
    if (area[i] === AREA.road || area[i] === AREA.yard) return -1;
    return null;
  };
  const link = (a: number | null, b: number | null) => {
    if (a === null || b === null || a === b) return;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      if (from < 0) continue;
      const set = links.get(from) ?? new Set<number>();
      set.add(to);
      links.set(from, set);
    }
  };
  area.forEach((code, i) => {
    if (code !== AREA.door) return;
    const col = i % cols;
    const row = (i / cols) | 0;
    if (col > 0 && col < cols - 1) link(side(i - 1), side(i + 1));
    if (row > 0 && row < rows - 1) link(side(i - cols), side(i + cols));
  });
  return links;
}

test("the same seed lays out the same world", () => {
  const first = build(testSimConfig.world, 9);
  const second = build(testSimConfig.world, 9);
  expect(second.map.solid).toEqual(first.map.solid);
  expect(second.layout).toEqual(first.layout);
  expect(build(testSimConfig.world, 10).map.solid).not.toEqual(first.map.solid);
});

describe.each(WORLDS)("%s world", (_, worldConfig) => {
  const { generation } = worldConfig;

  test.each(SEEDS)(
    "seed %i: a road runs unbroken from the left edge to the right, as wide as the config allows",
    (seed) => {
      const world = build(worldConfig, seed);
      const columns = roadColumns(world);
      for (const { width, unbroken } of columns) {
        expect(unbroken).toBe(true);
        expect(width).toBeGreaterThanOrEqual(generation.road.width.min);
        expect(width).toBeLessThanOrEqual(generation.road.width.max);
      }
      // Some bend: the road's middle is not the same row the whole way.
      const { cols, rows } = world.map;
      const middles = new Set(
        Array.from({ length: cols }, (_, col) => {
          let top = rows;
          for (let row = rows - 1; row >= 0; row--)
            if (world.layout.area[row * cols + col] === AREA.road) top = row;
          return top;
        }),
      );
      expect(middles.size).toBeGreaterThan(1);
      // The road is never solid.
      world.layout.area.forEach((code, i) => {
        if (code === AREA.road) expect(world.map.solid[i]).toBe(0);
      });
    },
  );

  test.each(SEEDS)(
    "seed %i: every open cell can be reached from the start, the exit included",
    (seed) => {
      const world = build(worldConfig, seed);
      const seen = reachable(world, middleCell(world, world.layout.start));
      world.map.solid.forEach((value, i) => {
        if (value === 0) expect(seen[i]).toBe(1);
      });
      expect(seen[middleCell(world, world.layout.exit)]).toBe(1);
    },
  );

  test.each(SEEDS)(
    "seed %i: the start is at the left end of the road, the exit at the right, both clear",
    (seed) => {
      const world = build(worldConfig, seed);
      const { start, exit } = world.layout;
      const { cell } = world.map;
      expect(start.x).toBe(0);
      expect(start.w).toBe(generation.start * cell);
      expect(exit.x + exit.w).toBe(world.W);
      expect(exit.w).toBe(generation.exit * cell);
      for (const zone of [start, exit]) {
        const middle = { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
        expect(areaAt(world, middle)).toBe("road");
        expect(isAreaFree(world.map, middle.x, middle.y, cell)).toBe(true);
      }
    },
  );

  test.each(SEEDS)(
    "seed %i: past the yards the world is mostly wall, with rooms joined by doors 1 to 3 wide",
    (seed) => {
      const world = build(worldConfig, seed);
      const { area, room, rooms } = world.layout;
      const indoors = [...area].filter(
        (code) => code !== AREA.road && code !== AREA.yard,
      );
      const walls = indoors.filter((code) => code === AREA.wall).length;
      expect(walls / indoors.length).toBeGreaterThan(0.4);
      expect(rooms.length).toBeGreaterThan(10);
      expect(rooms.some((each) => each.hallway)).toBe(true);
      // Every room cell is in a room listed, and every room has its cells.
      const counted = new Array<number>(rooms.length).fill(0);
      area.forEach((code, i) => {
        const id = room[i] ?? -1;
        expect(id >= 0).toBe(code === AREA.room);
        if (id >= 0) counted[id] = (counted[id] ?? 0) + 1;
      });
      expect(counted).toEqual(rooms.map((each) => each.cells));
      // No straight run of door cells is wider than 3.
      const { cols } = world.map;
      area.forEach((code, i) => {
        if (code !== AREA.door) return;
        for (const step of [1, cols]) {
          let run = 1;
          while (area[i + run * step] === AREA.door) run++;
          expect(run).toBeLessThanOrEqual(generation.rooms.door.max);
        }
      });
    },
  );

  test("most rooms have more than one way out, so paths loop", () => {
    let rooms = 0;
    let deadEnds = 0;
    for (const seed of SEEDS) {
      const world = build(worldConfig, seed);
      const links = roomLinks(world);
      for (const each of world.layout.rooms) {
        rooms++;
        if ((links.get(each.id)?.size ?? 0) <= 1) deadEnds++;
      }
    }
    expect(deadEnds / rooms).toBeLessThan(0.25);
  });

  test("clutter is thicker away from the road than beside it", () => {
    let near = 0;
    let nearSolid = 0;
    let far = 0;
    let farSolid = 0;
    for (const seed of SEEDS) {
      const world = build(worldConfig, seed);
      const { area, roadDistance } = world.layout;
      // Yard cells and the clutter in them, by their distance from the road.
      area.forEach((code, i) => {
        const d = roadDistance[i] ?? 0;
        if (d < 1 || d > generation.yard.depth.min) return;
        const outdoors = code === AREA.yard || code === AREA.wall;
        if (!outdoors) return;
        const solid = code === AREA.wall ? 1 : 0;
        if (d <= 1) {
          near++;
          nearSolid += solid;
        } else if (d === generation.yard.depth.min) {
          far++;
          farSolid += solid;
        }
      });
    }
    expect(farSolid / far).toBeGreaterThan(nearSolid / near);
  });
});

describe("regions", () => {
  const world = build(testSimConfig.world, 3);
  const { cell, cols } = world.map;
  const centreOf = (i: number) => ({
    x: ((i % cols) + 0.5) * cell,
    y: (((i / cols) | 0) + 0.5) * cell,
  });

  test("the road and yards are outdoors and in no room; a room's floor is indoors, in its room", () => {
    const roadCell = world.layout.area.indexOf(AREA.road);
    const yardCell = world.layout.area.indexOf(AREA.yard);
    const roomCell = world.layout.area.indexOf(AREA.room);
    for (const i of [roadCell, yardCell]) {
      expect(isOutdoors(world, centreOf(i))).toBe(true);
      expect(roomAt(world, centreOf(i))).toBeNull();
    }
    expect(isOutdoors(world, centreOf(roomCell))).toBe(false);
    expect(roomAt(world, centreOf(roomCell))?.id).toBe(
      world.layout.room[roomCell],
    );
    expect(areaAt(world, { x: -10, y: 10 })).toBe("wall");
  });

  test("remoteness runs from the road outwards and from left to right", () => {
    const roadCell = world.layout.area.indexOf(AREA.road);
    expect(remoteness(world, centreOf(roadCell)).road).toBe(0);
    const farthest = world.layout.roadDistance.findIndex(
      (d, i) => d === world.layout.farthest && world.map.solid[i] === 0,
    );
    expect(remoteness(world, centreOf(farthest)).road).toBe(1);
    expect(remoteness(world, { x: 0, y: 10 }).across).toBe(0);
    expect(remoteness(world, { x: world.W, y: 10 }).across).toBe(1);
  });

  test("danger grows with remoteness, from 0 on the road at the left to 1 at the far right", () => {
    const { road, right } = world.layout.danger;
    // A road cell in the leftmost column.
    const roadCell = world.layout.area.findIndex(
      (code, i) => code === AREA.road && i % cols === 0,
    );
    const onRoad = { x: 0, y: centreOf(roadCell).y };
    expect(dangerWeight(world, onRoad)).toBe(1);
    expect(danger(world, onRoad)).toBe(0);
    const farthest = world.layout.roadDistance.findIndex(
      (d, i) => d === world.layout.farthest && world.map.solid[i] === 0,
    );
    const far = centreOf(farthest);
    const across = far.x / world.W;
    expect(dangerWeight(world, far)).toBeCloseTo(
      (1 + road) * (1 + right * across),
    );
    expect(danger(world, { x: world.W, y: far.y })).toBeLessThanOrEqual(1);
    expect(danger(world, far)).toBeGreaterThan(danger(world, onRoad));
  });
});
