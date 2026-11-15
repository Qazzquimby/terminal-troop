import type { Point, TileMap } from "./map.js";
import { isSolid } from "./map.js";

/*
 * A body's shape. Most bodies are the disc of their radius. A kind may declare a box instead, such
 * as a car: `length` along the way it points and `width` across, turned by its heading. Its radius
 * stays half its length, the disc round the box, for whatever only needs a rough reach.
 */

/** A box's size: `length` along the way it points, `width` across. */
export interface BoxSize {
  readonly length: number;
  readonly width: number;
}

/** A box turned to `heading`, in radians, the way its length points. */
export interface BoxPose extends BoxSize {
  readonly heading: number;
}

/** A box turned to `heading` with its centre at (x, y). */
export interface Box extends Point, BoxPose {}

/**
 * Where a body is and what it fills: the disc of `radius` about its centre, or, with `box`, that
 * box about its centre, which the disc then holds.
 */
export interface Footprint extends Point {
  readonly radius: number;
  readonly box?: BoxPose | null;
}

/** Margin, in pixels, that two shapes must overlap by to count as touching. */
const EPSILON = 1e-6;

/** The unit vectors along `heading` and across it, to the right of it. */
export function axesOf(heading: number): { along: Point; across: Point } {
  const along = { x: Math.cos(heading), y: Math.sin(heading) };
  return { along, across: { x: -along.y, y: along.x } };
}

/** How far `box` reaches from its centre each way along the world's axes. */
function extents(box: BoxPose): Point {
  const c = Math.abs(Math.cos(box.heading));
  const s = Math.abs(Math.sin(box.heading));
  return {
    x: (c * box.length + s * box.width) / 2,
    y: (s * box.length + c * box.width) / 2,
  };
}

/**
 * Whether `box` overlaps the rectangle from (minX, minY) to (maxX, maxY) by more than a hair, by
 * the separating axes of both.
 */
function overlapsRect(
  box: Box,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const reach = extents(box);
  if (box.x + reach.x <= minX + EPSILON || box.x - reach.x >= maxX - EPSILON)
    return false;
  if (box.y + reach.y <= minY + EPSILON || box.y - reach.y >= maxY - EPSILON)
    return false;
  const { along, across } = axesOf(box.heading);
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
  ];
  for (const [axis, half] of [
    [along, box.length / 2],
    [across, box.width / 2],
  ] as const) {
    let low = Infinity;
    let high = -Infinity;
    for (const corner of corners) {
      const at = (corner.x - box.x) * axis.x + (corner.y - box.y) * axis.y;
      low = Math.min(low, at);
      high = Math.max(high, at);
    }
    if (high <= -half + EPSILON || low >= half - EPSILON) return false;
  }
  return true;
}

/** Whether `box` stands clear of every wall of `map` and inside it; touching a wall is clear. */
export function isBoxFree(map: TileMap, box: Box): boolean {
  if (![box.x, box.y, box.heading].every(Number.isFinite)) return false;
  const { cell } = map;
  const reach = extents(box);
  const minCol = Math.floor((box.x - reach.x) / cell);
  const maxCol = Math.floor((box.x + reach.x) / cell);
  const minRow = Math.floor((box.y - reach.y) / cell);
  const maxRow = Math.floor((box.y + reach.y) / cell);
  for (let row = minRow; row <= maxRow; row++)
    for (let col = minCol; col <= maxCol; col++) {
      if (!isSolid(map, col, row)) continue;
      const x = col * cell;
      const y = row * cell;
      if (overlapsRect(box, x, y, x + cell, y + cell)) return false;
    }
  return true;
}

/** Halvings a blocked move is searched by for how far it gets: to a hair's breadth. */
const SEARCH_STEPS = 24;

/**
 * Moves `box` by (dx, dy), one axis then the other, each as far as it goes clear of the walls of
 * `map`, so it slides along a wall it meets at a slant. Returns where it ends.
 */
export function moveBox(map: TileMap, box: Box, dx: number, dy: number): Point {
  let at: Box = box;
  for (const [x, y] of [
    [dx, 0],
    [0, dy],
  ] as const) {
    if (x === 0 && y === 0) continue;
    const to = (share: number): Box => ({
      ...at,
      x: at.x + x * share,
      y: at.y + y * share,
    });
    if (isBoxFree(map, to(1))) {
      at = to(1);
      continue;
    }
    let low = 0;
    let high = 1;
    for (let step = 0; step < SEARCH_STEPS; step++) {
      const mid = (low + high) / 2;
      if (isBoxFree(map, to(mid))) low = mid;
      else high = mid;
    }
    at = to(low);
  }
  return { x: at.x, y: at.y };
}

/** Pixels apart the spots are that a box nudged clear of a wall is tried at. */
const NUDGE_STEP = 1;

/**
 * The spot nearest `box`'s centre, no further than `limit`, where it stands clear of the walls of
 * `map`; null for none. Its own spot first.
 */
export function nudgeBoxFree(
  map: TileMap,
  box: Box,
  limit: number,
): Point | null {
  if (isBoxFree(map, box)) return { x: box.x, y: box.y };
  for (let radius = NUDGE_STEP; radius <= limit; radius += NUDGE_STEP) {
    const samples = Math.max(8, Math.ceil((radius * 2 * Math.PI) / NUDGE_STEP));
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const at = {
        x: box.x + Math.cos(angle) * radius,
        y: box.y + Math.sin(angle) * radius,
      };
      if (isBoxFree(map, { ...box, ...at })) return at;
    }
  }
  return null;
}

/**
 * `box` turned to `heading` where it stands, or nudged at most `nudge` clear of a wall the turn
 * swings it into; as it was, unturned, when no nudge that small clears it. So a box never turns
 * into a wall.
 */
export function turnBox(
  map: TileMap,
  box: Box,
  heading: number,
  nudge: number,
): Box {
  if (heading === box.heading) return box;
  const turned = { ...box, heading };
  const at = nudgeBoxFree(map, turned, nudge);
  return at === null ? box : { ...turned, ...at };
}

/** How far a point at `offset` from a box's centre lies along and across it. */
function local(box: BoxPose, offset: Point): Point {
  const { along, across } = axesOf(box.heading);
  return {
    x: offset.x * along.x + offset.y * along.y,
    y: offset.x * across.x + offset.y * across.y,
  };
}

/** How far `point` is from the edge of `body`'s footprint; 0 inside it. */
export function gapTo(body: Footprint, point: Point): number {
  const offset = { x: point.x - body.x, y: point.y - body.y };
  if (body.box === undefined || body.box === null)
    return Math.max(0, Math.hypot(offset.x, offset.y) - body.radius);
  const { x, y } = local(body.box, offset);
  return Math.hypot(
    Math.max(0, Math.abs(x) - body.box.length / 2),
    Math.max(0, Math.abs(y) - body.box.width / 2),
  );
}

/** Whether the disc of `radius` about `point` overlaps `body`'s footprint by more than a hair. */
export function touches(
  body: Footprint,
  point: Point,
  radius: number,
): boolean {
  return gapTo(body, point) < radius - EPSILON;
}

/** How far `body`'s footprint reaches from its centre along the unit vector `direction`. */
export function reachAlong(body: Footprint, direction: Point): number {
  if (body.box === undefined || body.box === null) return body.radius;
  const { x, y } = local(body.box, direction);
  return (Math.abs(x) * body.box.length + Math.abs(y) * body.box.width) / 2;
}

/**
 * Points spread over `body`'s footprint no more than about `spacing` apart, its centre first. A
 * disc's lie in rings out to its edge; a box's on a grid out to its edges and corners. A body no
 * bigger than a point is its centre alone.
 */
export function footprintPoints(body: Footprint, spacing: number): Point[] {
  const points: Point[] = [{ x: body.x, y: body.y }];
  if (spacing <= 0) return points;
  const { box } = body;
  if (box !== undefined && box !== null) {
    if (box.length <= 0 && box.width <= 0) return points;
    const { along, across } = axesOf(box.heading);
    const columns = Math.ceil(box.length / spacing);
    const rows = Math.ceil(box.width / spacing);
    for (let i = 0; i <= columns; i++)
      for (let j = 0; j <= rows; j++) {
        const u = columns === 0 ? 0 : (i / columns - 0.5) * box.length;
        const v = rows === 0 ? 0 : (j / rows - 0.5) * box.width;
        points.push({
          x: body.x + along.x * u + across.x * v,
          y: body.y + along.y * u + across.y * v,
        });
      }
    return points;
  }
  if (body.radius <= 0) return points;
  const rings = Math.ceil(body.radius / spacing);
  for (let ring = 1; ring <= rings; ring++) {
    const radius = (body.radius * ring) / rings;
    const count = Math.max(6, Math.ceil((Math.PI * 2 * radius) / spacing));
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      points.push({
        x: body.x + Math.cos(angle) * radius,
        y: body.y + Math.sin(angle) * radius,
      });
    }
  }
  return points;
}
