import { describe, expect, test } from "vitest";
import { z } from "zod";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import {
  createSession,
  isSweepFree,
  registerEntityType,
  spawnEntity,
} from "../sim/index.js";
import type { Point, TileMap } from "../sim/index.js";
import { avoidingLight, avoidingWhere, planRoute, steer } from "./route.js";

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

  describe("a body wider than a cell", () => {
    const WIDE = 72;

    /**
     * 16x12 cells of 50px, a wall across row 6 but for a gap one cell wide at column 7 and one
     * three cells wide at columns 12 to 14.
     */
    function gapped(): TileMap {
      const map = { cell: 50, cols: 16, rows: 12, solid: new Uint8Array(192) };
      for (let col = 0; col < 16; col++)
        if (col !== 7 && (col < 12 || col > 14)) map.solid[6 * 16 + col] = 1;
      return map;
    }

    const fits = (map: TileMap, half: number, from: Point, route: Point[]) =>
      route.every((to, i) => isSweepFree(map, half, route[i - 1] ?? from, to));

    test("goes the long way round, through a gap wide enough for it", () => {
      const map = gapped();
      const from = { x: 375, y: 150 };
      const to = { x: 375, y: 450 };
      const narrow = planRoute(map, HALF, from, to) ?? [];
      expect(narrow.some(({ x, y }) => y > 300 && x < 400)).toBe(true);
      expect(narrow.every(({ x }) => x < 500)).toBe(true);

      const wide = planRoute(map, WIDE, from, to) ?? [];
      expect(wide.at(-1)).toEqual(to);
      expect(wide.some(({ x }) => x > 600)).toBe(true);
      expect(fits(map, WIDE, from, wide)).toBe(true);
    });

    test("is null when no gap is wide enough", () => {
      const map = gapped();
      for (let col = 12; col <= 14; col++) map.solid[6 * 16 + col] = 1;
      expect(
        planRoute(map, WIDE, { x: 375, y: 150 }, { x: 375, y: 450 }),
      ).toBeNull();
    });
  });
});

describe("avoidingWhere", () => {
  test("judges each cell by its middle, once a plan however often asked", () => {
    const map = walled();
    const asked: Point[] = [];
    const avoid = avoidingWhere(map, (middle) => {
      asked.push(middle);
      return middle.x > 200;
    });
    expect(avoid({ col: 4, row: 1 })).toBe(true);
    expect(avoid({ col: 4, row: 1 })).toBe(true);
    expect(avoid({ col: 1, row: 1 })).toBe(false);
    expect(asked).toEqual([
      { x: 225, y: 75 },
      { x: 75, y: 75 },
    ]);
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

describe("planRoute avoiding cells", () => {
  /** 8x6 open cells of 50px. */
  const open = (): TileMap => ({
    cell: 50,
    cols: 8,
    rows: 6,
    solid: new Uint8Array(48),
  });
  /** Column 4, but for its bottom row. */
  const strip = ({ col, row }: { col: number; row: number }) =>
    col === 4 && row < 5;

  test("goes round the avoided cells, no leg crossing one", () => {
    const map = open();
    const from = { x: 75, y: 75 };
    const route = planRoute(map, HALF, from, { x: 375, y: 75 }, strip) ?? [];
    expect(route.at(-1)).toEqual({ x: 375, y: 75 });
    const legs = route.map((to, i) => [route[i - 1] ?? from, to] as const);
    for (const [a, b] of legs)
      for (let share = 0; share <= 1; share += 0.02) {
        const col = Math.floor((a.x + (b.x - a.x) * share) / 50);
        const row = Math.floor((a.y + (b.y - a.y) * share) / 50);
        expect(strip({ col, row })).toBe(false);
      }
  });

  test("is null when the avoided cells cut the way off, and may start on one", () => {
    const map = open();
    const column = ({ col }: { col: number }) => col === 4;
    expect(
      planRoute(map, HALF, { x: 75, y: 75 }, { x: 375, y: 75 }, column),
    ).toBeNull();
    expect(
      planRoute(map, HALF, { x: 225, y: 75 }, { x: 325, y: 75 }, column),
    ).toEqual([{ x: 325, y: 75 }]);
  });
});

test("avoidingLight names the cells a light reaches, and no others", () => {
  const game = createSession(
    "me",
    "ME",
    "ROUTE",
    "dev",
    testSfx(),
    testSimConfig,
  );
  registerEntityType(game, "lamp", {
    radius: 5,
    maxHealth: 1,
    collides: false,
    data: z.object({}),
    light: () => ({ range: 120 }),
    draw: () => undefined,
  });
  spawnEntity(game, "lamp", 425, 325, {});
  const avoid = avoidingLight(game);
  expect(avoid({ col: 8, row: 6 })).toBe(true);
  expect(avoid({ col: 10, row: 6 })).toBe(true);
  expect(avoid({ col: 1, row: 1 })).toBe(false);
});
