import { findPath } from "../lib/astar/index.js";
import type { Cell } from "../lib/astar/index.js";
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
 * Waypoints that take a body of half-size `half` from `from` to `to` round the walls, `from`
 * left out. They end at `to` where the body fits there, otherwise at the middle of its cell.
 * Null when no path joins them, or it needs more than MAX_WAYPOINTS.
 */
export function planRoute(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
): Point[] | null {
  const cells = findPath(map, cellOf(map, from), cellOf(map, to));
  const last = cells?.at(-1);
  if (cells === null || last === undefined) return null;
  const end = isAreaFree(map, to.x, to.y, half)
    ? { x: to.x, y: to.y }
    : centreOf(map, last);
  const between = cells.slice(1, -1).map((cell) => centreOf(map, cell));
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
