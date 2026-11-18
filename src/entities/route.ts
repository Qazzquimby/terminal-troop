import { findNearest, findPath } from "../lib/astar/index.js";
import type { Cell, Grid } from "../lib/astar/index.js";
import {
  closedDoors,
  darkSources,
  emittedLights,
  isAreaFree,
  isLit,
  isLitTo,
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

/** Margin, in cells, as `isAreaFree` takes a body's edges. */
const EPSILON = 1e-6;

/**
 * How many cells across a body of half-size `half` needs to pass: a square of that many cells
 * a side holds it, as collision has it. 1 for a body within a cell, 2 for one a little under two
 * cells wide. Every body plans its ways as a square of this many cells, so it plans through
 * exactly the gaps it fits.
 */
export function spanOf(cell: number, half: number): number {
  return Math.max(1, Math.ceil((half * 2) / cell - EPSILON));
}

/**
 * The square of `span` cells a side, by its top-left cell, whose middle is nearest `point`: for
 * one cell, the cell `point` is in.
 */
function squareAt(map: TileMap, span: number, point: Point): Cell {
  return {
    col: Math.round(point.x / map.cell - span / 2),
    row: Math.round(point.y / map.cell - span / 2),
  };
}

/**
 * The middle of the square of `span` cells a side whose top-left cell is `square`: a cell's middle
 * for an odd span, a corner where cells meet for an even one.
 */
function middleOf(map: TileMap, span: number, square: Cell): Point {
  return {
    x: (square.col + span / 2) * map.cell,
    y: (square.row + span / 2) * map.cell,
  };
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
 * `map` as a body `span` cells across sees it: each cell stands for the square of `span` cells a
 * side it is the top-left of, blocked where any cell of that square is a wall or off the world.
 * The map itself for a span of 1.
 */
function inflated(map: Grid, span: number): Grid {
  if (span === 1) return map;
  const { cols, rows } = map;
  const solid = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      if (col > cols - span || row > rows - span) solid[row * cols + col] = 1;
      if (map.solid[row * cols + col] !== 1) continue;
      for (let r = Math.max(0, row - span + 1); r <= row; r++)
        for (let c = Math.max(0, col - span + 1); c <= col; c++)
          solid[r * cols + c] = 1;
    }
  return { cols, rows, solid };
}

/** Whether `col`, `row` lies in the square of `span` cells a side whose top-left is `square`. */
function within(square: Cell, span: number, col: number, row: number): boolean {
  return (
    col >= square.col &&
    row >= square.row &&
    col < square.col + span &&
    row < square.row + span
  );
}

/**
 * The cells, edges included, a body `span` cells across passes over stepping from the square
 * whose top-left is `from` to the one whose top-left is `to`, a step one cell across, down or
 * both: the box round the two squares, the corners a diagonal step cuts past among them.
 */
function sweptBox(
  from: Cell,
  to: Cell,
  span: number,
): { left: number; top: number; right: number; bottom: number } {
  return {
    left: Math.min(from.col, to.col),
    top: Math.min(from.row, to.row),
    right: Math.max(from.col, to.col) + span - 1,
    bottom: Math.max(from.row, to.row) + span - 1,
  };
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
 * The toll a body `span` cells across pays for each step on `map`, square to square by top-left
 * cell, that brings a wall into what it passes over, as `sweptBox` has it: `wallCost`, once a step
 * however many walls it brings in, as the body breaks the whole face it presses at once. A
 * diagonal step pays for the corner it cuts past too. Its first step, from `start`,
 * pays for any wall at all: the body standing there is up against those walls at most, not
 * through them, though the square it starts in takes them in.
 */
function breakingToll(
  map: Grid,
  span: number,
  wallCost: number,
  start: Cell,
): (from: Cell, to: Cell) => number {
  const { cols, rows, solid } = map;
  return (from, to) => {
    const first = from.col === start.col && from.row === start.row;
    const box = sweptBox(from, to, span);
    for (let row = box.top; row <= box.bottom; row++)
      for (let col = box.left; col <= box.right; col++) {
        if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
        const filled = !first && within(from, span, col, row);
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
 * The toll a body `span` cells across pays for each step that brings a closed door of `doors` into
 * what it passes over, as `sweptBox` has it: that door's toll, the dearest of them if more than one. Its first step, from
 * `start`, pays for any it fills at all, as `breakingToll` has it.
 */
function doorToll(
  cols: number,
  doors: ReadonlyMap<number, ClosedDoor>,
  span: number,
  start: Cell,
): (from: Cell, to: Cell) => number {
  return (from, to) => {
    const first = from.col === start.col && from.row === start.row;
    let toll = 0;
    const box = sweptBox(from, to, span);
    for (let row = box.top; row <= box.bottom; row++)
      for (let col = box.left; col <= box.right; col++) {
        if (col < 0 || row < 0 || col >= cols) continue;
        const door = doors.get(row * cols + col);
        if (door === undefined) continue;
        const filled = !first && within(from, span, col, row);
        if (!filled) toll = Math.max(toll, door.toll);
      }
    return toll;
  };
}

/**
 * Where a body `span` cells across standing at `point` starts or ends on `grid`, as `inflated`
 * has it: the open square, by top-left cell, whose middle is nearest `point`, searched out a cell
 * further than half the body round the square nearest it. Just that square for a body within a
 * cell. Null for none.
 */
function nearestOpen(
  map: TileMap,
  grid: Grid,
  span: number,
  point: Point,
): Cell | null {
  const square = squareAt(map, span, point);
  const rings = span === 1 ? 0 : Math.floor(span / 2) + 1;
  let best: Cell | null = null;
  let bestDistance = Infinity;
  for (let row = square.row - rings; row <= square.row + rings; row++)
    for (let col = square.col - rings; col <= square.col + rings; col++) {
      if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
      if (grid.solid[row * grid.cols + col] === 1) continue;
      const middle = middleOf(map, span, { col, row });
      const distance = Math.hypot(middle.x - point.x, middle.y - point.y);
      if (distance < bestDistance) {
        best = { col, row };
        bestDistance = distance;
      }
    }
  return best;
}

/**
 * `avoid` for squares `span` cells a side by top-left cell, as the planner steps them: a square
 * is avoided where the cell under its middle is, the cell a body standing there has its middle in.
 */
function avoidingSquares(
  map: TileMap,
  span: number,
  avoid: Avoid | undefined,
): Avoid | undefined {
  if (avoid === undefined || span === 1) return avoid;
  return (square) => avoid(cellOf(map, middleOf(map, span, square)));
}

/**
 * Waypoints that take a body of half-size `half` from `from` to `to` round the walls, through
 * gaps wide enough for it, `from` left out, and through no cell `avoid` names but those it starts
 * and ends in. The body plans as a square of `spanOf` cells a side, the square collision holds it
 * in, so it goes through every gap that many cells wide and none narrower: a body a little under
 * two cells across through a gap of two, its waypoints where cells meet. They end at `to` where
 * the body fits there, otherwise at the middle of the nearest square it fits in. A body wider
 * than a cell starts and ends at the nearest squares it fits in. A cell `avoid` names keeps off
 * the body's middle. Null when no path joins them, or it needs more than MAX_WAYPOINTS.
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
  const span = spanOf(map.cell, half);
  const doors =
    throughDoors && wallCost === undefined
      ? closedDoors(map)
      : new Map<number, ClosedDoor>();
  const grid = inflated(
    wallCost === undefined ? doorsOpen(map, doors) : unwalled(map),
    span,
  );
  const start = nearestOpen(map, grid, span, from);
  const goal = nearestOpen(map, grid, span, to);
  if (start === null || goal === null) return null;
  const toll =
    wallCost !== undefined
      ? breakingToll(map, span, wallCost, start)
      : doors.size > 0
        ? doorToll(map.cols, doors, span, start)
        : undefined;
  const squares = findPath(
    grid,
    start,
    goal,
    avoidingSquares(map, span, avoid),
    toll,
  );
  const last = squares?.at(-1);
  if (squares === null || last === undefined) return null;
  const end = isAreaFree(map, to.x, to.y, half)
    ? { x: to.x, y: to.y }
    : middleOf(map, span, last);
  const own = squareAt(map, span, from);
  const moved = own.col !== start.col || own.row !== start.row;
  const between = squares
    .slice(moved ? 0 : 1, -1)
    .map((square) => middleOf(map, span, square));
  const route = straighten(map, half, from, [...between, end], avoid);
  return route.length > MAX_WAYPOINTS ? null : route;
}

/**
 * Waypoints that take a body of half-size `half` from `from`, by the cheapest walk round the
 * walls, to the middle of the nearest square it fits in, as `planRoute` has squares, whose middle
 * `wanted` names: the first such square it can reach, so the soonest it can be there at any
 * speed. `from` left out; empty when the square it starts in is wanted. Null when it reaches none, or the way needs more than MAX_WAYPOINTS.
 * `wanted` is asked of each cell once at most, nearest first, so it may be costly.
 */
export function routeToNearest(
  map: TileMap,
  half: number,
  from: Point,
  wanted: (middle: Point) => boolean,
): Point[] | null {
  const span = spanOf(map.cell, half);
  const grid = inflated(map, span);
  const start = nearestOpen(map, grid, span, from);
  if (start === null) return null;
  const squares = findNearest(grid, start, (square) =>
    wanted(middleOf(map, span, square)),
  );
  if (squares === null) return null;
  const own = squareAt(map, span, from);
  const moved = own.col !== start.col || own.row !== start.row;
  const points = squares
    .slice(moved ? 0 : 1)
    .map((square) => middleOf(map, span, square));
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
  return avoidingWhere(game.world.map, (at) =>
    isLit(game, at, lights, darks, id),
  );
}

/**
 * The way for the body `self` out of the light, to the nearest ground dark to it as `isLitTo` has
 * it, straight through lit ground, so the soonest it can be in the dark: its last point is the
 * dark spot. Null when it stands in the dark already, takes the world for dark, or can reach no
 * dark ground. For any kind that makes for the dark when light falls on it; see `DarkSeeking`.
 */
export function wayToDark(
  game: Session,
  self: Point & { readonly id: string; readonly radius: number },
): Point[] | null {
  if (!isLitTo(game, self.id, self)) return null;
  const { map } = game.world;
  const lights = emittedLights(game);
  const darks = darkSources(game);
  const route = routeToNearest(
    map,
    self.radius,
    self,
    (at) => !isLit(game, at, lights, darks, self.id),
  );
  if (route === null) return null;
  if (route.length > 0) return route;
  const span = spanOf(map.cell, self.radius);
  return [middleOf(map, span, squareAt(map, span, self))];
}

/** A kind that, opting in, makes for the dark before anything else when light falls on it. */
export interface DarkSeeking {
  /**
   * Whether light falling on it sends it to the nearest dark ground first, by `wayToDark`, and
   * keeps its ways off lit ground where it can. A kind that opts in takes `SHUNS_LIGHT_TAG`.
   */
  readonly seeksDark: boolean;
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
