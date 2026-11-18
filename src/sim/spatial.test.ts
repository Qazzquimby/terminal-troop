import { describe, expect, test } from "vitest";
import { emptyMap, mapWithCenterWall } from "../integration/tile-maps.js";
import type { CollisionBody } from "./collision.js";
import { separateBodies, separatePair } from "./collision.js";
import type { TileMap } from "./map.js";
import { mulberry32 } from "./map.js";
import { SpatialGrid } from "./spatial.js";

const within = (
  points: readonly { x: number; y: number }[],
  at: { x: number; y: number },
  range: number,
): number[] =>
  points.flatMap((point, index) =>
    Math.hypot(point.x - at.x, point.y - at.y) <= range ? [index] : [],
  );

/** Points far off, so a grid has more points than the cells a small range covers. */
const far = Array.from({ length: 8 }, (_, index) => ({ x: -9000, y: index }));

describe("spatial grid", () => {
  test("finds every point within range, in list order", () => {
    const rng = mulberry32(7);
    const points = Array.from({ length: 300 }, () => ({
      x: (rng() - 0.5) * 1000,
      y: (rng() - 0.5) * 1000,
    }));
    const grid = new SpatialGrid(points, 32);
    for (let i = 0; i < 50; i++) {
      const at = { x: (rng() - 0.5) * 1000, y: (rng() - 0.5) * 1000 };
      const range = rng() * 120;
      const near = grid.near(at, range);
      expect(near).toEqual([...near].sort((a, b) => a - b));
      const inRange = near.filter((index) => {
        const point = points[index];
        return (
          point !== undefined &&
          Math.hypot(point.x - at.x, point.y - at.y) <= range
        );
      });
      expect(inRange).toEqual(within(points, at, range));
    }
  });

  test("follows a point that moved once told", () => {
    const points = [{ x: 0, y: 0 }, { x: 500, y: 500 }, ...far];
    const grid = new SpatialGrid(points, 10);
    const [first] = points;
    if (first === undefined) throw new Error("no point");
    first.x = 490;
    first.y = 495;
    grid.moved(0);
    expect(grid.near({ x: 495, y: 495 }, 6)).toEqual([0, 1]);
    expect(grid.near({ x: 0, y: 0 }, 4)).toEqual([]);
  });

  test("a point that is not finite is near everywhere", () => {
    const points = [
      { x: 0, y: 0 },
      { x: NaN, y: 0 },
      { x: 1000, y: Infinity },
      ...far,
    ];
    const grid = new SpatialGrid(points, 10);
    expect(grid.near({ x: 0, y: 0 }, 1)).toEqual([0, 1, 2]);
    expect(grid.near({ x: 5000, y: 5000 }, 1)).toEqual([1, 2]);
  });

  test("a range or place that is not finite reaches every point", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 1e6, y: -1e6 },
    ];
    const grid = new SpatialGrid(points, 10);
    expect(grid.near({ x: 0, y: 0 }, Infinity)).toEqual([0, 1]);
    expect(grid.near({ x: NaN, y: 0 }, 1)).toEqual([0, 1]);
    expect(grid.near({ x: 0, y: 0 }, 1e7)).toEqual([0, 1]);
  });

  test("rejects a cell of no size", () => {
    expect(() => new SpatialGrid([], 0)).toThrow();
  });
});

/** Separation as it was before the grid: every pair, in list order. */
function separateEveryPair(
  bodies: readonly CollisionBody[],
  map: TileMap,
  movable: ReadonlySet<CollisionBody>,
): void {
  for (let pass = 0; pass < 16; pass++) {
    let moved = false;
    for (const [index, first] of bodies.entries())
      for (const second of bodies.slice(index + 1))
        if (separatePair(first, second, map, movable)) moved = true;
    if (!moved) return;
  }
}

/** Bodies crowded at random, some overlapping, a few movable only. */
function crowd(seed: number, count: number): CollisionBody[] {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, () => ({
    x: 60 + rng() * 140,
    y: 60 + rng() * 140,
    vx: (rng() - 0.5) * 50,
    vy: (rng() - 0.5) * 50,
    radius: 4 + rng() * 14,
  }));
}

describe("separation through the grid", () => {
  test.each([1, 2, 3, 4, 5])(
    "moves crowded bodies exactly as going over every pair does (seed %i)",
    (seed) => {
      for (const map of [emptyMap(), mapWithCenterWall()]) {
        const ours = crowd(seed, 40);
        const theirs = ours.map((body) => ({ ...body }));
        const movable = (bodies: CollisionBody[]) =>
          new Set(bodies.filter((_, index) => index % 5 !== 0));
        separateBodies(ours, map, movable(ours));
        separateEveryPair(theirs, map, movable(theirs));
        expect(ours).toEqual(theirs);
      }
    },
  );
});
