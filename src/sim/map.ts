import { range } from "lodash-es";

/** The world's size and grid, and how bodies meet its walls. */
export interface WorldConfig {
  /** Side of one map cell, in pixels. */
  readonly cell: number;
  /** Size of the standard world, in cells. */
  readonly cols: number;
  readonly rows: number;
  /** Mixed with the room code to seed the standard world. */
  readonly seed: number;
  /** Share of a body's speed kept, reversed, when it hits a wall. */
  readonly wallBounce: number;
}

/** The size of the screen's view of the world, in pixels. */
export interface ViewConfig {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface TileMap {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major; 1 is solid. */
  readonly solid: Uint8Array;
}

export interface World {
  readonly W: number;
  readonly H: number;
  readonly map: TileMap;
}

export type Rng = () => number;

/** "standard" is the procedural world; "dev" is a one-screen square for testing. */
export const WORLD_KINDS = ["standard", "dev"] as const;

export type WorldKind = (typeof WORLD_KINDS)[number];

type Cell = readonly [col: number, row: number];

const EPSILON = 1e-6;

// Tuning
const CHUNK = 6; // chunk size in cells (only used to spread obstacles out)
const GAP = 1; // min free cells between any two obstacles / the border

// Obstacle shapes as [col, row] cells. Must not contain holes
// prettier-ignore
const SHAPES: readonly (readonly Cell[])[] = [
  [[0, 0]], // 1x1
  [[0, 0], [1, 0]], // 1x2
  [[0, 0], [1, 0], [2, 0]], // 1x3
  [[0, 0], [1, 0], [2, 0], [3, 0]], // 1x4
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], // 1x5
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], // 1x6
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0]], // 1x7
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0]], // 1x8

  [[0, 0], [1, 0], [0, 1], [1, 1]], // 2x2
  [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]], // 2x3 C

  [[0, 0], [0, 1], [1, 1], [2, 1]], // 2x2 L
  [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]], // 2x3 L

  [[0, 0], [1, 0], [2, 0], [1, 1]], // 2x2 T
  [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]], // 2x3 T

  [[0, 0], [1, 0], [1, 1], [2, 1], [2, 2]], // 2x3 zigzag
  [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]], // plus
];

/** One draw from a mulberry32 generator in `state`: a value in [0, 1), and the state after it. */
export function mulberry32Next(state: number): {
  value: number;
  state: number;
} {
  const next = ((state | 0) + 0x6d2b79f5) | 0;
  let value = Math.imul(next ^ (next >>> 15), 1 | next);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return { value: ((value ^ (value >>> 14)) >>> 0) / 4294967296, state: next };
}

export function mulberry32(seed: number): Rng {
  let state = seed;
  return function () {
    const draw = mulberry32Next(state);
    state = draw.state;
    return draw.value;
  };
}

function pick<T>(items: readonly T[], rng: Rng): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined)
    throw new RangeError("Cannot pick from an empty list.");
  return item;
}

/** Rotates a quarter turn `times` times. */
function rotate(cells: Cell[], times: number): Cell[] {
  return times <= 0
    ? cells
    : rotate(
        cells.map(([c, r]): Cell => [-r, c]),
        times - 1,
      );
}

function transform(
  shape: readonly Cell[],
  rot: number,
  mirror: boolean,
): Cell[] {
  const cells = rotate(
    shape.map(([c, r]): Cell => [mirror ? -c : c, r]),
    rot,
  );
  const minC = Math.min(...cells.map((p) => p[0]));
  const minR = Math.min(...cells.map((p) => p[1]));
  return cells.map(([c, r]) => [c - minC, r - minR]);
}

function shuffle(arr: unknown[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) continue;
    arr[i] = b;
    arr[j] = a;
  }
}

function canPlace(
  solid: Uint8Array,
  cols: number,
  rows: number,
  cells: readonly Cell[],
  ox: number,
  oy: number,
): boolean {
  return cells.every(([dc, dr]) => {
    const c = ox + dc;
    const r = oy + dr;
    // Stay GAP cells away from the border, and from every other obstacle
    const inBounds = c >= GAP && r >= GAP && c < cols - GAP && r < rows - GAP;
    return inBounds && neighbourhoodClear(solid, cols, c, r);
  });
}

/** True when no cell within GAP of (c, r) is solid. Caller keeps (c, r) GAP from the edge. */
function neighbourhoodClear(
  solid: Uint8Array,
  cols: number,
  c: number,
  r: number,
): boolean {
  return range(r - GAP, r + GAP + 1).every((rr) =>
    range(c - GAP, c + GAP + 1).every((cc) => solid[rr * cols + cc] !== 1),
  );
}

/**
 * Keep only the largest connected free region; everything else becomes solid.
 * Obstacles are already spaced so this should be a no-op, but it is a hard
 * guarantee that nobody can spawn in a sealed-off pocket.
 */
function sealDisconnected(solid: Uint8Array, cols: number, rows: number): void {
  const region = new Int32Array(cols * rows).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];

  for (let start = 0; start < solid.length; start++) {
    if (solid[start] === 1 || region[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    region[start] = id;
    stack.push(start);
    for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
      size++;
      const c = i % cols;
      const r = (i / cols) | 0;
      const next = [
        c > 0 ? i - 1 : -1,
        c < cols - 1 ? i + 1 : -1,
        r > 0 ? i - cols : -1,
        r < rows - 1 ? i + cols : -1,
      ];
      for (const n of next) {
        if (n >= 0 && solid[n] !== 1 && region[n] === -1) {
          region[n] = id;
          stack.push(n);
        }
      }
    }
    sizes.push(size);
  }

  if (sizes.length <= 1) return;
  const best = sizes.indexOf(Math.max(...sizes));
  solid.forEach((value, i) => {
    if (value !== 1 && region[i] !== best) solid[i] = 1;
  });
}

/**
 * Pass a seeded rng (e.g. mulberry32) if every client must build the same map.
 */
export function createMap(
  cols: number,
  rows: number,
  cell: number,
  rng: Rng = Math.random,
): TileMap {
  const solid = new Uint8Array(cols * rows);

  // Visit chunks in random order, but place shapes at jittered positions
  // (not snapped to chunk edges) with random rotation/mirroring, so the
  // result doesn't read as a grid.
  const chunks = range(0, rows, CHUNK).flatMap((cy) =>
    range(0, cols, CHUNK).map((cx): Cell => [cx, cy]),
  );
  shuffle(chunks, rng);

  for (const [cx, cy] of chunks) {
    const wanted = rng() < 0.5 ? 3 : 2; // most chunks get 2 obstacles, some 3
    let placed = 0;
    for (let attempt = 0; attempt < 20 && placed < wanted; attempt++) {
      const shape = pick(SHAPES, rng);
      const cells = transform(shape, Math.floor(rng() * 4), rng() < 0.5);
      const ox = cx - 1 + Math.floor(rng() * (CHUNK + 2));
      const oy = cy - 1 + Math.floor(rng() * (CHUNK + 2));
      if (!canPlace(solid, cols, rows, cells, ox, oy)) continue;
      cells.forEach(([dc, dr]) => {
        solid[(oy + dr) * cols + (ox + dc)] = 1;
      });
      placed++;
    }
  }

  sealDisconnected(solid, cols, rows);

  return { cell, cols, rows, solid };
}

/** The standard world at `config`'s size; `rng` lays out its obstacles. */
export function buildWorld(config: WorldConfig, rng: Rng): World {
  const { cols, rows, cell } = config;
  return {
    W: cols * cell,
    H: rows * cell,
    map: createMap(cols, rows, cell, rng),
  };
}

/** Top-left cells of the dev square's 2x2 pillars, off-centre so the middle rows and columns stay clear. */
export const DEV_PILLARS: readonly Cell[] = [
  [4, 1],
  [12, 9],
];

/**
 * One screen of open floor with two small pillars. Deterministic; the border is the edge of the
 * world, which `isSolid` already treats as solid.
 */
export function buildDevWorld(cell: number, view: ViewConfig): World {
  const cols = view.width / cell;
  const rows = view.height / cell;
  const solid = new Uint8Array(cols * rows);
  for (const [col, row] of DEV_PILLARS) {
    for (const [dc, dr] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      solid[(row + dr) * cols + (col + dc)] = 1;
    }
  }
  return {
    W: view.width,
    H: view.height,
    map: { cell, cols, rows, solid },
  };
}

export function isSolid(map: TileMap, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  return map.solid[row * map.cols + col] === 1;
}

export function isAreaFree(
  map: TileMap,
  x: number,
  y: number,
  half: number,
): boolean {
  const minCol = Math.floor((x - half) / map.cell + EPSILON);
  const maxCol = Math.floor((x + half) / map.cell - EPSILON);
  const minRow = Math.floor((y - half) / map.cell + EPSILON);
  const maxRow = Math.floor((y + half) / map.cell - EPSILON);

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (isSolid(map, col, row)) return false;
    }
  }

  return true;
}

export function randomFreePosition(
  world: World,
  clearance: number,
  rng: Rng = Math.random,
): Point {
  const { W, H, map } = world;

  for (;;) {
    const x = clearance + rng() * (W - clearance * 2);
    const y = clearance + rng() * (H - clearance * 2);
    if (isAreaFree(map, x, y, clearance)) return { x, y };
  }
}
