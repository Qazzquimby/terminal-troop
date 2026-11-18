import { expect, test } from "vitest";
import { AREA } from "../sim/index.js";
import type { TileMap } from "../sim/index.js";
import { roadReach, spanOf } from "./road-reach.js";

const CELL = 10;

/**
 * A map drawn row by row: `R` road, `.` yard, `#` wall, `D` a shut door, `d` an open one. Each
 * row the same length.
 */
function drawn(rows: readonly string[]): {
  map: TileMap;
  area: Uint8Array;
} {
  const cols = rows[0]?.length ?? 0;
  const solid = new Uint8Array(cols * rows.length);
  const area = new Uint8Array(cols * rows.length);
  rows.forEach((line, row) => {
    Array.from(line, (mark, col) => {
      const index = row * cols + col;
      solid[index] = mark === "#" || mark === "D" ? 1 : 0;
      area[index] =
        mark === "R"
          ? AREA.road
          : mark === "#"
            ? AREA.wall
            : mark === "D" || mark === "d"
              ? AREA.door
              : AREA.yard;
    });
  });
  return { map: { cell: CELL, cols, rows: rows.length, solid }, area };
}

/** The squares `roadReach` finds joined, drawn as rows: `+` joined, `-` not. */
function reached(rows: readonly string[], span: number): string[] {
  const { map, area } = drawn(rows);
  const reach = roadReach(map, area, span);
  return rows.map((line, row) =>
    Array.from(line, (_, col) =>
      reach[row * map.cols + col] === 1 ? "+" : "-",
    ).join(""),
  );
}

test("a body's span is the cells across it needs: two for one a little under two cells wide", () => {
  expect(spanOf(CELL, 0)).toBe(1);
  expect(spanOf(CELL, CELL / 2)).toBe(1);
  expect(spanOf(CELL, CELL - 3)).toBe(2);
  expect(spanOf(CELL, CELL)).toBe(2);
  expect(spanOf(CELL, CELL + 1)).toBe(3);
});

test("a single cell reaches the road wherever open ground joins them, by steps across or down", () => {
  expect(
    reached(
      [
        "RRRRRR", //
        "..#...",
        "###.##",
        "...#..",
        "..#...",
      ],
      1,
    ),
  ).toEqual([
    "++++++", //
    "++-+++",
    "---+--",
    "------",
    "------",
  ]);
});

test("a body two cells across gets through a way two wide, not one", () => {
  const wide = [
    "RRRRRRRRRR", //
    "##..####.#",
    "##..####.#",
    "..........",
    "..........",
  ];
  // Squares by their top-left cell, down the two-wide way at the left and out across the yard.
  expect(reached(wide, 2)).toEqual([
    "--+-------", //
    "--+-------",
    "--+-------",
    "+++++++++-",
    "----------",
  ]);
  const narrow = [
    "RRRRRRRRRR", //
    "###.####.#",
    "###.####.#",
    "..........",
    "..........",
  ];
  expect(reached(narrow, 1)[3]).toBe("++++++++++");
  expect(reached(narrow, 2).every((row) => !row.includes("+"))).toBe(true);
});

test("a shut door counts as open ground, as every body gets through one", () => {
  const rows = [
    "RRRR", //
    "##D#",
    "....",
  ];
  expect(reached(rows, 1)[2]).toBe("++++");
  expect(reached(["RRRR", "##d#", "...."], 1)[2]).toBe("++++");
});

test("ground joined to the road only at a corner is cut off", () => {
  expect(
    reached(
      [
        "RR##", //
        "##..",
      ],
      1,
    ),
  ).toEqual(["++--", "----"]);
});

test("a square standing on any road cell is joined, and none hangs past the map's edge", () => {
  expect(reached(["...", "..R"], 2)).toEqual(["++-", "---"]);
});
