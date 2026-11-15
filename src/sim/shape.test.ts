import { expect, test } from "vitest";
import type { TileMap } from "./map.js";
import {
  footprintPoints,
  gapTo,
  isBoxFree,
  moveBox,
  reachAlong,
  touches,
  turnBox,
} from "./shape.js";

/** An open 10x10 map of 50px cells, walled where `walls` says, [col, row]. */
function mapWith(walls: readonly (readonly [number, number])[]): TileMap {
  const cols = 10;
  const solid = new Uint8Array(cols * cols);
  for (const [col, row] of walls) solid[row * cols + col] = 1;
  return { cell: 50, cols, rows: cols, solid };
}

/** A wall along row 4, y 200..250. */
const ROW_4 = Array.from({ length: 10 }, (_, col) => [col, 4] as const);

const CAR = { length: 100, width: 40 };

test("a box lying along a wall is free at its own half-width, though its length would not fit across", () => {
  const map = mapWith(ROW_4);
  const beside = { ...CAR, x: 250, y: 200 - 20, heading: 0 };
  expect(isBoxFree(map, beside)).toBe(true);
  expect(isBoxFree(map, { ...beside, y: 200 - 19 })).toBe(false);
  // Turned across the wall, the same spot runs it into the wall.
  expect(isBoxFree(map, { ...beside, heading: Math.PI / 2 })).toBe(false);
  // Turned a little, its corner dips in.
  expect(isBoxFree(map, { ...beside, heading: 0.1 })).toBe(false);
});

test("a box driving along a wall at a slant slides along it, its side flush", () => {
  const map = mapWith(ROW_4);
  const box = { ...CAR, x: 250, y: 150, heading: 0 };
  const to = moveBox(map, box, 30, 60);
  expect(to.x).toBeCloseTo(280, 9);
  expect(to.y).toBeCloseTo(180, 5);
  expect(to.y).toBeLessThanOrEqual(180);
  expect(isBoxFree(map, { ...box, ...to })).toBe(true);
});

test("a box turning into a wall it touches is nudged clear, or not turned at all", () => {
  const map = mapWith(ROW_4);
  const box = { ...CAR, x: 250, y: 180, heading: 0 };
  const nudged = turnBox(map, box, 0.02, 2);
  expect(nudged.heading).toBe(0.02);
  expect(nudged.y).toBeLessThan(180);
  expect(isBoxFree(map, nudged)).toBe(true);
  // A turn too far for so small a nudge leaves it as it was.
  expect(turnBox(map, box, 0.5, 2)).toEqual(box);
  // Hemmed in by walls above and below, it cannot turn at all.
  const hemmed = mapWith([
    ...ROW_4,
    ...Array.from({ length: 10 }, (_, col) => [col, 2] as const),
  ]);
  const slot = { ...CAR, width: 50, x: 250, y: 175, heading: 0 };
  expect(turnBox(hemmed, slot, 0.02, 2)).toEqual(slot);
});

test("how far a point is from a body: from a box's edge or corner, or a disc's rim", () => {
  const box = { x: 0, y: 0, radius: 50, box: { ...CAR, heading: 0 } };
  expect(gapTo(box, { x: 0, y: 30 })).toBeCloseTo(10, 9);
  expect(gapTo(box, { x: 60, y: 0 })).toBeCloseTo(10, 9);
  expect(gapTo(box, { x: 53, y: 24 })).toBeCloseTo(5, 9);
  expect(gapTo(box, { x: 10, y: 5 })).toBe(0);
  // Turned upright, its sides face left and right.
  const upright = { ...box, box: { ...CAR, heading: Math.PI / 2 } };
  expect(gapTo(upright, { x: 30, y: 0 })).toBeCloseTo(10, 9);
  expect(gapTo({ x: 0, y: 0, radius: 50 }, { x: 0, y: 60 })).toBeCloseTo(10, 9);
  expect(touches(box, { x: 0, y: 30 }, 12)).toBe(true);
  expect(touches(box, { x: 0, y: 30 }, 8)).toBe(false);
  expect(reachAlong(box, { x: 0, y: 1 })).toBeCloseTo(20, 9);
  expect(reachAlong(box, { x: 1, y: 0 })).toBeCloseTo(50, 9);
});

test("a box's footprint points cover it out to its corners, and none lies outside it", () => {
  const body = { x: 100, y: 100, radius: 50, box: { ...CAR, heading: 0.7 } };
  const points = footprintPoints(body, 10);
  expect(points[0]).toEqual({ x: 100, y: 100 });
  for (const point of points) expect(gapTo(body, point)).toBeLessThan(1e-9);
  const corner = {
    x: 100 + Math.cos(0.7) * 50 - Math.sin(0.7) * 20,
    y: 100 + Math.sin(0.7) * 50 + Math.cos(0.7) * 20,
  };
  expect(
    points.some(
      (point) => Math.hypot(point.x - corner.x, point.y - corner.y) < 1e-9,
    ),
  ).toBe(true);
});
