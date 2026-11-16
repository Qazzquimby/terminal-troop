import { describe, expect, test } from "vitest";
import type { Cell, Grid } from "./index.js";
import { findNearest, findPath } from "./index.js";

/** A grid drawn as rows of text: `#` is blocked, anything else is free. */
function grid(...lines: string[]): Grid {
  const cols = lines[0]?.length ?? 0;
  const solid = new Uint8Array(
    lines.flatMap((line) => Array.from(line, (char) => (char === "#" ? 1 : 0))),
  );
  return { cols, rows: lines.length, solid };
}

const cell = (col: number, row: number): Cell => ({ col, row });

/** The path's cost: 1 a straight step, √2 a diagonal one. */
function cost(path: readonly Cell[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.col - a.col, b.row - a.row);
  }
  return total;
}

/** Whether every step moves to a neighbour, never through a blocked corner. */
function legal(map: Grid, path: readonly Cell[]): boolean {
  const blocked = (col: number, row: number) =>
    map.solid[row * map.cols + col] === 1;
  return path.every((to, i) => {
    const from = path[i - 1];
    if (from === undefined) return true;
    const dc = to.col - from.col;
    const dr = to.row - from.row;
    if (Math.max(Math.abs(dc), Math.abs(dr)) !== 1) return false;
    if (blocked(to.col, to.row)) return false;
    return (
      dc === 0 ||
      dr === 0 ||
      (!blocked(from.col + dc, from.row) && !blocked(from.col, from.row + dr))
    );
  });
}

describe("findPath", () => {
  test("a path to the start cell is that cell alone", () => {
    expect(findPath(grid("..."), cell(1, 0), cell(1, 0))).toEqual([cell(1, 0)]);
  });

  test("open ground takes the diagonal, at octile cost", () => {
    const map = grid(".....", ".....", ".....", ".....");
    const path = findPath(map, cell(0, 0), cell(4, 3));
    expect(path?.[0]).toEqual(cell(0, 0));
    expect(path?.at(-1)).toEqual(cell(4, 3));
    expect(cost(path ?? [])).toBeCloseTo(1 + 3 * Math.SQRT2);
  });

  test("goes around a wall at the cheapest cost", () => {
    const map = grid(
      // prettier-ignore
      ".......",
      "...#...",
      "...#...",
      "...#...",
      ".......",
      ".......",
    );
    const path = findPath(map, cell(1, 2), cell(5, 2)) ?? [];
    expect(legal(map, path)).toBe(true);
    expect(path.at(-1)).toEqual(cell(5, 2));
    expect(cost(path)).toBeCloseTo(4 + 2 * Math.SQRT2);
  });

  test("never cuts a blocked corner", () => {
    const map = grid(
      // prettier-ignore
      ".#",
      "..",
    );
    expect(findPath(map, cell(0, 0), cell(1, 1))).toEqual([
      cell(0, 0),
      cell(0, 1),
      cell(1, 1),
    ]);
  });

  test("does not squeeze diagonally between two blocked cells", () => {
    const map = grid(
      // prettier-ignore
      ".#",
      "#.",
    );
    expect(findPath(map, cell(0, 0), cell(1, 1))).toBeNull();
  });

  test("winds through a maze along legal steps", () => {
    const map = grid(
      // prettier-ignore
      "..#.....",
      "..#.##..",
      "..#..#..",
      "....#...",
      "###.#.##",
      "........",
    );
    const path = findPath(map, cell(0, 0), cell(7, 0)) ?? [];
    expect(path.at(-1)).toEqual(cell(7, 0));
    expect(legal(map, path)).toBe(true);
  });

  test.each([
    ["a blocked goal", cell(1, 0)],
    ["a goal off the grid", cell(5, 0)],
    ["a goal walled off", cell(2, 0)],
  ])("is null for %s", (_label, goal) => {
    expect(findPath(grid(".#."), cell(0, 0), goal)).toBeNull();
  });

  test("is null from a blocked start", () => {
    expect(findPath(grid("#.."), cell(0, 0), cell(2, 0))).toBeNull();
  });
});

describe("findNearest", () => {
  test("walks to the wanted cell cheapest to reach, not the nearest as the crow flies", () => {
    const map = grid(
      // prettier-ignore
      ".#.",
      ".#.",
      "...",
    );
    // (2, 0) is two columns off as the crow flies, but six steps round the wall; (0, 2) is two.
    const wanted = (at: Cell) =>
      (at.col === 2 && at.row === 0) || (at.col === 0 && at.row === 2);
    const path = findNearest(map, cell(0, 0), wanted) ?? [];
    expect(path.at(-1)).toEqual(cell(0, 2));
    expect(legal(map, path)).toBe(true);
  });

  test("is just the start when the start is wanted", () => {
    expect(findNearest(grid("..."), cell(1, 0), () => true)).toEqual([
      cell(1, 0),
    ]);
  });

  test("is null when no wanted cell is reachable, or from a blocked start", () => {
    const wanted = (at: Cell) => at.col === 2;
    expect(findNearest(grid(".#."), cell(0, 0), wanted)).toBeNull();
    expect(findNearest(grid("#.."), cell(0, 0), wanted)).toBeNull();
  });
});
