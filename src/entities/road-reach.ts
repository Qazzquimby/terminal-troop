import { AREA, destroyedWalls } from "../sim/index.js";
import type { Point, Session, TileMap } from "../sim/index.js";
import { spanOf } from "./route.js";

/** Margin, in cells, as `isAreaFree` takes a body's edges. */
const EPSILON = 1e-6;

/**
 * Which squares of `span` cells a side, each by its top-left cell, row-major, stand clear in
 * `map` and are joined to the road by steps of one cell across or down, every square on the way
 * clear too: 1 for those, 0 for the rest. A square touching a road cell of `area` is joined. A
 * door's cell counts as clear, shut or not, since every body that presses a door opens or bashes
 * it. Diagonal steps are not taken: a body cannot squeeze past where two squares meet at a corner.
 */
export function roadReach(
  map: TileMap,
  area: Uint8Array,
  span: number,
): Uint8Array {
  const { cols, rows, solid } = map;
  // Running sums over the cells, a row and column of zeros ahead, to count a square in four reads.
  const stride = cols + 1;
  const blocked = new Int32Array(stride * (rows + 1));
  const road = new Int32Array(stride * (rows + 1));
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const at = (row + 1) * stride + col + 1;
      const shut = solid[index] === 1 && area[index] !== AREA.door ? 1 : 0;
      const onRoad = area[index] === AREA.road ? 1 : 0;
      blocked[at] = shut + sumBefore(blocked, at, stride);
      road[at] = onRoad + sumBefore(road, at, stride);
    }
  const within = (sums: Int32Array, col: number, row: number): number => {
    const top = row * stride + col;
    const bottom = (row + span) * stride + col;
    return (
      (sums[bottom + span] ?? 0) -
      (sums[bottom] ?? 0) -
      (sums[top + span] ?? 0) +
      (sums[top] ?? 0)
    );
  };
  const reach = new Uint8Array(cols * rows);
  const queue: number[] = [];
  const lastCol = cols - span;
  const lastRow = rows - span;
  const clear = new Uint8Array(cols * rows);
  for (let row = 0; row <= lastRow; row++)
    for (let col = 0; col <= lastCol; col++) {
      if (within(blocked, col, row) > 0) continue;
      const index = row * cols + col;
      clear[index] = 1;
      if (within(road, col, row) === 0) continue;
      reach[index] = 1;
      queue.push(index);
    }
  // Squares pushed as it goes are visited in turn: an array's iterator reads its length each step.
  for (const index of queue) {
    const col = index % cols;
    const row = (index - col) / cols;
    for (const [dc, dr] of STEPS) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c > lastCol || r > lastRow) continue;
      const next = r * cols + c;
      if (clear[next] === 0 || reach[next] === 1) continue;
      reach[next] = 1;
      queue.push(next);
    }
  }
  return reach;
}

/** The running sum `sums` holds over the cells before `at` in its row and those above it. */
function sumBefore(sums: Int32Array, at: number, stride: number): number {
  const above = at - stride;
  return (sums[at - 1] ?? 0) + (sums[above] ?? 0) - (sums[above - 1] ?? 0);
}

/** The steps a square may take: one cell across or down. */
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A map's road reach for one span, and how many walls were down when it was found. */
interface Found {
  readonly down: number;
  readonly reach: Uint8Array;
}

/** Each map's road reach by span, found once and again only as walls come down. */
const found = new WeakMap<TileMap, Map<number, Found>>();

/**
 * Whether a body of half-size `half` standing at `at` could walk to the road from there, by ways
 * wide enough for it, as `roadReach` has it. Found once a world for each size of body, and again
 * whenever walls have come down since; doors opening and shutting change nothing, as every body
 * gets through a shut one. False where the body does not fit.
 */
export function reachesRoad(game: Session, at: Point, half: number): boolean {
  const { map, layout } = game.world;
  const span = spanOf(map.cell, half);
  const col = Math.floor((at.x - half) / map.cell + EPSILON);
  const row = Math.floor((at.y - half) / map.cell + EPSILON);
  if (col < 0 || row < 0 || col > map.cols - span || row > map.rows - span)
    return false;
  const down = destroyedWalls.get(game).length;
  const bySpan = found.get(map) ?? new Map<number, Found>();
  found.set(map, bySpan);
  let held = bySpan.get(span);
  if (held?.down !== down) {
    held = { down, reach: roadReach(map, layout.area, span) };
    bySpan.set(span, held);
  }
  return held.reach[row * map.cols + col] === 1;
}
