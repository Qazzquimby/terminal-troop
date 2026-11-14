import { findPath } from "../lib/astar/index.js";
import type { Cell, Grid } from "../lib/astar/index.js";
import { isAreaFree, isSweepFree } from "../sim/index.js";
import type { Point, TileMap } from "../sim/index.js";

/** Longest route a monster keeps; a longer one is not taken. */
export const MAX_WAYPOINTS = 32;

function cellOf(map: TileMap, point: Point): Cell {
  return {
    col: Math.floor(point.x / map.cell),
    row: Math.floor(point.y / map.cell),
  };
}

function centreOf(map: TileMap, cell: Cell): Point {
  return { x: (cell.col + 0.5) * map.cell, y: (cell.row + 0.5) * map.cell };
}

/**
 * Keeps only the waypoints a body of half-size `half` cannot skip: from each one kept it
 * heads straight for the furthest one after it that it fits all the way to.
 */
function straighten(
  map: TileMap,
  half: number,
  from: Point,
  points: readonly Point[],
): Point[] {
  const kept: Point[] = [];
  let anchor = from;
  for (let i = 0; i < points.length;) {
    let reach = i;
    for (
      let next = points[reach + 1];
      next !== undefined && isSweepFree(map, half, anchor, next);
      next = points[reach + 1]
    )
      reach++;
    const point = points[reach];
    if (point === undefined) break;
    kept.push(point);
    anchor = point;
    i = reach + 1;
  }
  return kept;
}

/**
 * How many cells round its own a body of half-size `half` fills, standing mid-cell: none for a
 * body within one cell, one for a body up to three cells across.
 */
function reachOf(map: TileMap, half: number): number {
  return Math.max(0, Math.ceil(half / map.cell - 0.5 - 1e-9));
}

/**
 * `map` as a body filling `reach` cells round its own sees it: a cell is blocked where any cell
 * within `reach` of it, or the world's edge, is a wall. The map itself for a reach of 0.
 */
function inflated(map: TileMap, reach: number): Grid {
  if (reach === 0) return map;
  const { cols, rows } = map;
  const solid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const edge =
        col < reach ||
        row < reach ||
        col >= cols - reach ||
        row >= rows - reach;
      if (!edge && map.solid[row * cols + col] !== 1) continue;
      for (let r = row - reach; r <= row + reach; r++)
        for (let c = col - reach; c <= col + reach; c++)
          if (c >= 0 && r >= 0 && c < cols && r < rows) solid[r * cols + c] = 1;
    }
  return { cols, rows, solid };
}

/** The open cell of `grid` nearest `cell`, searched out `rings` cells round it; null for none. */
function nearestOpen(grid: Grid, cell: Cell, rings: number): Cell | null {
  let best: Cell | null = null;
  let bestDistance = Infinity;
  for (let row = cell.row - rings; row <= cell.row + rings; row++)
    for (let col = cell.col - rings; col <= cell.col + rings; col++) {
      if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
      if (grid.solid[row * grid.cols + col] === 1) continue;
      const distance = Math.hypot(col - cell.col, row - cell.row);
      if (distance < bestDistance) {
        best = { col, row };
        bestDistance = distance;
      }
    }
  return best;
}

/**
 * Waypoints that take a body of half-size `half` from `from` to `to` round the walls, through
 * gaps wide enough for it, `from` left out. They end at `to` where the body fits there,
 * otherwise at the middle of the nearest cell it fits in. A body wider than a cell starts and
 * ends at the nearest cells it fits in, searched out a cell further than it fills. Null when no
 * path joins them, or it needs more than MAX_WAYPOINTS.
 */
export function planRoute(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
): Point[] | null {
  const reach = reachOf(map, half);
  const grid = inflated(map, reach);
  const rings = reach === 0 ? 0 : reach + 1;
  const start = nearestOpen(grid, cellOf(map, from), rings);
  const goal = nearestOpen(grid, cellOf(map, to), rings);
  if (start === null || goal === null) return null;
  const cells = findPath(grid, start, goal);
  const last = cells?.at(-1);
  if (cells === null || last === undefined) return null;
  const end = isAreaFree(map, to.x, to.y, half)
    ? { x: to.x, y: to.y }
    : centreOf(map, last);
  const own = cellOf(map, from);
  const moved = own.col !== start.col || own.row !== start.row;
  const between = cells
    .slice(moved ? 0 : 1, -1)
    .map((cell) => centreOf(map, cell));
  const route = straighten(map, half, from, [...between, end]);
  return route.length > MAX_WAYPOINTS ? null : route;
}

/** A body that steers by setting its velocity. */
interface Steered extends Point {
  vx: number;
  vy: number;
}

/**
 * Points `body` along `route` at `speed` for a step of `dt`, and returns the route left once
 * the step is taken. A waypoint within the step is landed on exactly; with no route left the
 * body stops.
 */
export function steer(
  body: Steered,
  route: readonly Point[],
  speed: number,
  dt: number,
): Point[] {
  const [next, ...rest] = route;
  if (next === undefined) {
    body.vx = 0;
    body.vy = 0;
    return [];
  }
  const dx = next.x - body.x;
  const dy = next.y - body.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= speed * dt) {
    body.vx = dx / dt;
    body.vy = dy / dt;
    return rest;
  }
  body.vx = (dx / distance) * speed;
  body.vy = (dy / distance) * speed;
  return [...route];
}
