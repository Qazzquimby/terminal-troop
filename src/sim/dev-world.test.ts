import { expect, test } from "vitest";
import { createSfx } from "../audio/index.js";
import { MAP_CELL, VIEW_H, VIEW_W, WORLD_COLS, WORLD_ROWS } from "./config.js";
import type { TileMap } from "./map.js";
import { DEV_PILLARS, buildDevWorld, isSolid } from "./map.js";
import { createSession, roomKey } from "./session.js";

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
  const { W, H, map } = buildDevWorld();
  expect({ W, H }).toEqual({ W: VIEW_W, H: VIEW_H });
  expect({ cell: map.cell, cols: map.cols, rows: map.rows }).toEqual({
    cell: MAP_CELL,
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
  const { map } = buildDevWorld();
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
  expect(solidCells(buildDevWorld().map)).toEqual([
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
  const dev = createSession("a", "A", "ABC", "dev", createSfx());
  expect(dev.world.map.solid).toEqual(buildDevWorld().map.solid);

  const standard = createSession("a", "A", "ABC", "standard", createSfx());
  expect(standard.world.W).toBe(WORLD_COLS * MAP_CELL);
  expect(standard.world.H).toBe(WORLD_ROWS * MAP_CELL);
  expect(fingerprint(standard.world.map)).toBe(968259081);
});
