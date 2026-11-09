import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import type { TileMap } from "./map.js";
import { DEV_PILLARS, buildDevWorld, isSolid } from "./map.js";
import { createSession, roomKey } from "./session.js";

const CELL = 50;
const VIEW = { width: 900, height: 600 };
/** The standard world whose layout the fingerprint below pins. */
const WORLD = { cell: CELL, cols: 160, rows: 120, seed: 1, wallBounce: 0 };
const config = { ...testSimConfig, world: WORLD, view: VIEW };

const devWorld = () => buildDevWorld(CELL, VIEW);

function solidCells(map: TileMap): string[] {
  const cells: string[] = [];
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (isSolid(map, col, row)) cells.push(`${String(col)},${String(row)}`);
    }
  }
  return cells;
}

/** FNV-1a over the solid cells, to pin the standard world's layout. */
function fingerprint(map: TileMap): number {
  let hash = 2166136261;
  for (const value of map.solid) hash = Math.imul(hash ^ value, 16777619);
  return hash >>> 0;
}

test("the dev square is exactly one screen with a solid border", () => {
  const { W, H, map } = devWorld();
  expect({ W, H }).toEqual({ W: 900, H: 600 });
  expect({ cell: map.cell, cols: map.cols, rows: map.rows }).toEqual({
    cell: CELL,
    cols: 18,
    rows: 12,
  });
  for (let col = 0; col < map.cols; col++) {
    expect(isSolid(map, col, -1)).toBe(true);
    expect(isSolid(map, col, map.rows)).toBe(true);
  }
  for (let row = 0; row < map.rows; row++) {
    expect(isSolid(map, -1, row)).toBe(true);
    expect(isSolid(map, map.cols, row)).toBe(true);
  }
});

test("the dev square's centre rows and columns are open end to end", () => {
  const { map } = devWorld();
  for (const row of [5, 6]) {
    for (let col = 0; col < map.cols; col++) {
      expect(isSolid(map, col, row)).toBe(false);
    }
  }
  for (const col of [8, 9]) {
    for (let row = 0; row < map.rows; row++) {
      expect(isSolid(map, col, row)).toBe(false);
    }
  }
});

test("the dev square's only obstacles are its two 2x2 pillars", () => {
  expect(DEV_PILLARS).toEqual([
    [4, 1],
    [12, 9],
  ]);
  expect(solidCells(devWorld().map)).toEqual([
    "4,1",
    "5,1",
    "4,2",
    "5,2",
    "12,9",
    "13,9",
    "12,10",
    "13,10",
  ]);
});

test("the room key keeps the plain code for standard and tags other worlds", () => {
  expect(roomKey("ABC", "standard")).toBe("ABC");
  expect(roomKey("ABC", "dev")).toBe("dev:ABC");
});

test("sessions build the world their kind names", () => {
  const dev = createSession("a", "A", "ABC", "dev", testSfx(), config);
  expect(dev.world.map.solid).toEqual(devWorld().map.solid);

  const standard = createSession(
    "a",
    "A",
    "ABC",
    "standard",
    testSfx(),
    config,
  );
  expect(standard.world.W).toBe(160 * CELL);
  expect(standard.world.H).toBe(120 * CELL);
  expect(fingerprint(standard.world.map)).toBe(968259081);
});
