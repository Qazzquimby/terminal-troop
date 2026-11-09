import { describe, expect, test } from "vitest";
import { isSweepFree } from "../sim/index.js";
import type { Point, TileMap } from "../sim/index.js";
import { planRoute, steer } from "./route.js";

const HALF = 15;

/** 8x6 cells of 50px, a wall down column 3 from row 0 to row 3. */
function walled(): TileMap {
  const map = { cell: 50, cols: 8, rows: 6, solid: new Uint8Array(48) };
  for (let row = 0; row < 4; row++) map.solid[row * map.cols + 3] = 1;
  return map;
}

/** Every leg of `route` from `from` fits a body of HALF. */
function clear(map: TileMap, from: Point, route: readonly Point[]): boolean {
  return route.every((to, i) =>
    isSweepFree(map, HALF, route[i - 1] ?? from, to),
  );
}

describe("planRoute", () => {
  test("in the open it heads straight for the goal", () => {
    const map = walled();
    expect(planRoute(map, HALF, { x: 25, y: 275 }, { x: 380, y: 260 })).toEqual(
      [{ x: 380, y: 260 }],
    );
  });

  test("goes round a wall in a few legs that each fit the body", () => {
    const map = walled();
    const from = { x: 75, y: 75 };
    const route = planRoute(map, HALF, from, { x: 275, y: 75 }) ?? [];
    expect(route.at(-1)).toEqual({ x: 275, y: 75 });
    expect(route.length).toBeGreaterThan(1);
    expect(route.length).toBeLessThanOrEqual(4);
    expect(clear(map, from, route)).toBe(true);
  });

  test("ends mid-cell when the goal is too near a wall for the body", () => {
    const map = walled();
    const route = planRoute(map, HALF, { x: 75, y: 275 }, { x: 140, y: 75 });
    expect(route?.at(-1)).toEqual({ x: 125, y: 75 });
  });

  test("is null when the goal is inside a wall", () => {
    expect(
      planRoute(walled(), HALF, { x: 75, y: 75 }, { x: 175, y: 75 }),
    ).toBeNull();
  });
});

describe("steer", () => {
  test("heads for the next waypoint at speed", () => {
    const body = { x: 0, y: 0, vx: 0, vy: 0 };
    const route = [
      { x: 0, y: 100 },
      { x: 50, y: 100 },
    ];
    expect(steer(body, route, 60, 1 / 60)).toEqual(route);
    expect(body).toMatchObject({ vx: 0, vy: 60 });
  });

  test("lands exactly on a waypoint within the step, and drops it", () => {
    const body = { x: 0, y: 0, vx: 0, vy: 0 };
    const rest = steer(
      body,
      [
        { x: 0.5, y: 0 },
        { x: 50, y: 0 },
      ],
      60,
      1 / 60,
    );
    expect(rest).toEqual([{ x: 50, y: 0 }]);
    expect(body.vx * (1 / 60)).toBeCloseTo(0.5);
  });

  test("stops with no route", () => {
    const body = { x: 0, y: 0, vx: 5, vy: 5 };
    expect(steer(body, [], 60, 1 / 60)).toEqual([]);
    expect(body).toMatchObject({ vx: 0, vy: 0 });
  });
});
