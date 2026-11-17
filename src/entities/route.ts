import { findNearest, findPath } from "../lib/astar/index.js";
import type { Cell, Grid } from "../lib/astar/index.js";
import {
  closedDoors,
  darkSources,
  emittedLights,
  isAreaFree,
  isLit,
  isShrouded,
  isSweepFree,
} from "../sim/index.js";
import type { ClosedDoor, Point, Session, TileMap } from "../sim/index.js";

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
 * A cell a route keeps off, past the walls: lit ground, say, or ground some player sees. A route
 * may still start or end on one.
 */
export type Avoid = (cell: Cell) => boolean;

/** Points looked at per cell of a leg's length when checking it crosses no avoided cell. */
const LEG_SAMPLES_PER_CELL = 4;

/**
 * Whether the straight leg from `a` to `b` passes through a cell `avoid` names, the cells it
 * starts and ends in aside.
 */
function crosses(map: TileMap, avoid: Avoid, a: Point, b: Point): boolean {
  const start = cellOf(map, a);
  const end = cellOf(map, b);
  const steps = Math.ceil(
    (Math.hypot(b.x - a.x, b.y - a.y) / map.cell) * LEG_SAMPLES_PER_CELL,
  );
  for (let step = 1; step < steps; step++) {
    const share = step / steps;
    const cell = cellOf(map, {
      x: a.x + (b.x - a.x) * share,
      y: a.y + (b.y - a.y) * share,
    });
    const isStart = cell.col === start.col && cell.row === start.row;
    const isEnd = cell.col === end.col && cell.row === end.row;
    if (!isStart && !isEnd && avoid(cell)) return true;
  }
  return false;
}

/**
 * Keeps only the waypoints a body of half-size `half` cannot skip: from each one kept it
 * heads straight for the furthest one after it that it fits all the way to, crossing no cell
 * `avoid` names.
 */
function straighten(
  map: TileMap,
  half: number,
  from: Point,
  points: readonly Point[],
  avoid: Avoid | undefined,
): Point[] {
  const clear = (a: Point, b: Point): boolean =>
    isSweepFree(map, half, a, b) &&
    (avoid === undefined || !crosses(map, avoid, a, b));
  const kept: Point[] = [];
  let anchor = from;
  for (let i = 0; i < points.length;) {
    let reach = i;
    for (
      let next = points[reach + 1];
      next !== undefined && clear(anchor, next);
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
function inflated(map: Grid, reach: number): Grid {
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

/** `map` with every wall gone, its size alone kept: as a body that breaks walls plans on it. */
function unwalled(map: Grid): Grid {
  return {
    cols: map.cols,
    rows: map.rows,
    solid: new Uint8Array(map.solid.length),
  };
}

/**
 * The toll a body filling `reach` cells round its own pays for each step on `map` that brings a
 * wall into what it fills: `wallCost`, once a step however many walls it brings in, as the body
 * breaks the whole face it presses at once. Its first step, from `start`, pays for any wall at
 * all: the body standing there is up against those walls at most, not through them, though the
 * cells round its own take them in.
 */
function breakingToll(
  map: Grid,
  reach: number,
  wallCost: number,
  start: Cell,
): (from: Cell, to: Cell) => number {
  const { cols, rows, solid } = map;
  return (from, to) => {
    const first = from.col === start.col && from.row === start.row;
    for (let row = to.row - reach; row <= to.row + reach; row++)
      for (let col = to.col - reach; col <= to.col + reach; col++) {
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        const filled =
          !first &&
          Math.abs(col - from.col) <= reach &&
          Math.abs(row - from.row) <= reach;
        if (!filled && solid[row * cols + col] === 1) return wallCost;
      }
    return 0;
  };
}

/** `map` with the cells of `doors` open: as a body that would get through them plans on it. */
function doorsOpen(map: Grid, doors: ReadonlyMap<number, ClosedDoor>): Grid {
  if (doors.size === 0) return map;
  const solid = map.solid.slice();
  for (const index of doors.keys()) solid[index] = 0;
  return { cols: map.cols, rows: map.rows, solid };
}

/**
 * The toll a body filling `reach` cells round its own pays for each step that brings a closed door
 * of `doors` into what it fills: that door's toll, the dearest of them if more than one. Its first
 * step, from `start`, pays for any it fills at all, as `breakingToll` has it.
 */
function doorToll(
  cols: number,
  doors: ReadonlyMap<number, ClosedDoor>,
  reach: number,
  start: Cell,
): (from: Cell, to: Cell) => number {
  return (from, to) => {
    const first = from.col === start.col && from.row === start.row;
    let toll = 0;
    for (let row = to.row - reach; row <= to.row + reach; row++)
      for (let col = to.col - reach; col <= to.col + reach; col++) {
        if (col < 0 || row < 0 || col >= cols) continue;
        const door = doors.get(row * cols + col);
        if (door === undefined) continue;
        const filled =
          !first &&
          Math.abs(col - from.col) <= reach &&
          Math.abs(row - from.row) <= reach;
        if (!filled) toll = Math.max(toll, door.toll);
      }
    return toll;
  };
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
 * gaps wide enough for it, `from` left out, and through no cell `avoid` names but those it starts
 * and ends in. They end at `to` where the body fits there, otherwise at the middle of the nearest
 * cell it fits in. A body wider than a cell starts and ends at the nearest cells it fits in,
 * searched out a cell further than it fills. Null when no path joins them, or it needs more than
 * MAX_WAYPOINTS.
 *
 * A body that breaks walls gives `wallCost`: how many cells it could walk in the time it takes to
 * break through the walls in its way. Its route then goes through a wall wherever breaking it is
 * quicker than walking round, the world's edge alone stopping it, and leaves the breaking to it.
 * A closed door is one of those walls to it.
 *
 * Any other body's route goes through a closed door `throughDoors`, as a body that wants to be on
 * the other side does, wherever the door's toll is less than the walk round; it ends up pressing the
 * door, which opens or bashes it. A wanderer passes false, and keeps to the open ways.
 */
export function planRoute(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
  avoid?: Avoid,
  wallCost?: number,
  throughDoors = true,
): Point[] | null {
  const reach = reachOf(map, half);
  const doors =
    throughDoors && wallCost === undefined
      ? closedDoors(map)
      : new Map<number, ClosedDoor>();
  const grid = inflated(
    wallCost === undefined ? doorsOpen(map, doors) : unwalled(map),
    reach,
  );
  const rings = reach === 0 ? 0 : reach + 1;
  const start = nearestOpen(grid, cellOf(map, from), rings);
  const goal = nearestOpen(grid, cellOf(map, to), rings);
  if (start === null || goal === null) return null;
  const toll =
    wallCost !== undefined
      ? breakingToll(map, reach, wallCost, start)
      : doors.size > 0
        ? doorToll(map.cols, doors, reach, start)
        : undefined;
  const cells = findPath(grid, start, goal, avoid, toll);
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
  const route = straighten(map, half, from, [...between, end], avoid);
  return route.length > MAX_WAYPOINTS ? null : route;
}

/**
 * Waypoints that take a body of half-size `half` from `from`, by the cheapest walk round the
 * walls, to the middle of the nearest cell it fits in whose middle `wanted` names: the first such
 * cell it can reach, so the soonest it can be there at any speed. `from` left out; empty when the
 * cell it starts in is wanted. Null when it reaches none, or the way needs more than MAX_WAYPOINTS.
 * `wanted` is asked of each cell once at most, nearest first, so it may be costly.
 */
export function routeToNearest(
  map: TileMap,
  half: number,
  from: Point,
  wanted: (middle: Point) => boolean,
): Point[] | null {
  const reach = reachOf(map, half);
  const grid = inflated(map, reach);
  const rings = reach === 0 ? 0 : reach + 1;
  const start = nearestOpen(grid, cellOf(map, from), rings);
  if (start === null) return null;
  const cells = findNearest(grid, start, (cell) => wanted(centreOf(map, cell)));
  if (cells === null) return null;
  const own = cellOf(map, from);
  const moved = own.col !== start.col || own.row !== start.row;
  const points = cells.slice(moved ? 0 : 1).map((cell) => centreOf(map, cell));
  if (points.length === 0) return [];
  const route = straighten(map, half, from, points, undefined);
  return route.length > MAX_WAYPOINTS ? null : route;
}

/**
 * Keeps the route of the body `id` off ground lit now, as `isLitTo` has it: by its place's own
 * light or a light given off there, out of any darkness given off. A shrouded body takes the whole
 * world for dark, and keeps off nothing. Each cell is judged by its middle, once a plan, so make
 * one for each plan.
 */
export function avoidingLight(game: Session, id: string): Avoid {
  if (isShrouded(game, id)) return () => false;
  const lights = emittedLights(game);
  const darks = darkSources(game);
  return avoidingWhere(game.world.map, (at) => isLit(game, at, lights, darks));
}

/**
 * Keeps a route off each cell whose middle `test` names, each cell judged once: make one for each
 * plan.
 */
export function avoidingWhere(
  map: TileMap,
  test: (middle: Point) => boolean,
): Avoid {
  const judged = new Map<number, boolean>();
  return (cell) => {
    const key = cell.row * map.cols + cell.col;
    const known = judged.get(key);
    if (known !== undefined) return known;
    const avoided = test(centreOf(map, cell));
    judged.set(key, avoided);
    return avoided;
  };
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
