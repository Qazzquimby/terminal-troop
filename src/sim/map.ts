import type { GenerationConfig } from "./generation.js";

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
  /** How the standard world lays out its road, yards and buildings. */
  readonly generation: GenerationConfig;
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

/** An axis-aligned box, in pixels. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface TileMap {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** Row-major; 1 is solid. */
  readonly solid: Uint8Array;
}

/**
 * What each cell of a world is part of:
 * - wall: solid, whether a building's mass or clutter in a yard
 * - road: the open way from the start to the exit; outdoors
 * - yard: open ground between the road and the buildings; outdoors
 * - room: floor inside a building, in one of the layout's rooms
 * - door: an opening in a building's wall, between two rooms or a room and outdoors
 */
const AREAS = ["wall", "road", "yard", "room", "door"] as const;

export type Area = (typeof AREAS)[number];

/** Each area's code in `Layout.area`. */
export const AREA = {
  wall: 0,
  road: 1,
  yard: 2,
  room: 3,
  door: 4,
} as const satisfies Record<Area, number>;

/** One room of a building: its id is its index in `Layout.rooms`. */
export interface Room {
  readonly id: number;
  /** The smallest box of cells holding it. */
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
  /** How many floor cells it has. */
  readonly cells: number;
  /** Whether it is a long, narrow room: a hallway. */
  readonly hallway: boolean;
  /** Which building it is part of: rooms sharing walls, joined by doors inside, numbered from 0. */
  readonly building: number;
  /** Whether it has a light fixture, which lights it while it has power. */
  readonly fixture: boolean;
  /** Whether it has power; see `powerRooms`. */
  readonly powered: boolean;
}

/** What the world's cells are part of, and where its journey starts and ends. */
export interface Layout {
  /** Row-major, each cell's `AREA` code. */
  readonly area: Uint8Array;
  /** Row-major, the id of the room each cell is floor of; -1 for none. */
  readonly room: Int16Array;
  readonly rooms: readonly Room[];
  /** Row-major, how many cells each cell is from the nearest road cell, diagonals counting one. */
  readonly roadDistance: Uint16Array;
  /** The largest of `roadDistance` over open cells; 0 when every open cell is road. */
  readonly farthest: number;
  /** Where the players and the cruiser begin: the left end of the road. */
  readonly start: Rect;
  /** Where the cruiser takes the players out: the right end of the road. */
  readonly exit: Rect;
  /** How dangerous its places are; see `dangerWeight`. */
  readonly danger: DangerConfig;
}

export interface World {
  readonly W: number;
  readonly H: number;
  readonly map: TileMap;
  readonly layout: Layout;
}

export type Rng = () => number;

/** "standard" is the procedural world; "dev" is a one-screen square for testing. */
export const WORLD_KINDS = ["standard", "dev"] as const;

export type WorldKind = (typeof WORLD_KINDS)[number];

type Cell = readonly [col: number, row: number];

const EPSILON = 1e-6;

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

/** Top-left cells of the dev square's 2x2 pillars, off-centre so the middle rows and columns stay clear. */
export const DEV_PILLARS: readonly Cell[] = [
  [4, 1],
  [12, 9],
];

/** Columns of the dev square at each end that are its start and its exit. */
const DEV_ZONE_COLS = 3;

/**
 * One screen of open floor with two small pillars, all of it one dark room, so the lights carried
 * into it show: its leftmost three columns are the start, its rightmost three the exit.
 * Deterministic; the border is the edge of the world, which `isSolid` already treats as solid.
 */
export function buildDevWorld(
  cell: number,
  view: ViewConfig,
  danger: DangerConfig,
): World {
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
  const zone = DEV_ZONE_COLS * cell;
  return {
    W: view.width,
    H: view.height,
    map: { cell, cols, rows, solid },
    layout: {
      area: solid.map((value) => (value === 1 ? AREA.wall : AREA.room)),
      room: Int16Array.from(solid, (value) => (value === 1 ? -1 : 0)),
      rooms: [
        {
          id: 0,
          col: 0,
          row: 0,
          cols,
          rows,
          cells: solid.filter((value) => value === 0).length,
          hallway: false,
          building: 0,
          fixture: false,
          powered: false,
        },
      ],
      roadDistance: new Uint16Array(cols * rows),
      farthest: 0,
      start: { x: 0, y: 0, w: zone, h: view.height },
      exit: { x: view.width - zone, y: 0, w: zone, h: view.height },
      danger,
    },
  };
}

export function isSolid(map: TileMap, col: number, row: number): boolean {
  if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return true;
  return map.solid[row * map.cols + col] === 1;
}

/** The index of the cell holding `at`, or -1 when it is outside the world. */
function cellIndex(world: World, at: Point): number {
  const { cell, cols, rows } = world.map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  if (!(col >= 0 && row >= 0 && col < cols && row < rows)) return -1;
  return row * cols + col;
}

/** What the cell holding `at` is part of; outside the world is wall. */
export function areaAt(world: World, at: Point): Area {
  const index = cellIndex(world, at);
  const code = index < 0 ? AREA.wall : world.layout.area[index];
  return AREAS[code ?? AREA.wall] ?? "wall";
}

/** Whether `at` is out of doors: on the road or in a yard. */
export function isOutdoors(world: World, at: Point): boolean {
  const area = areaAt(world, at);
  return area === "road" || area === "yard";
}

/** The room `at` stands in, or null when it is in none. */
export function roomAt(world: World, at: Point): Room | null {
  const index = cellIndex(world, at);
  const id = index < 0 ? -1 : (world.layout.room[index] ?? -1);
  return world.layout.rooms[id] ?? null;
}

/**
 * How remote `at` is, each 0..1: `road`, how far it is from the road as a share of the farthest
 * open cell; `across`, how far across the world from the start's side to the exit's.
 */
export function remoteness(
  world: World,
  at: Point,
): { readonly road: number; readonly across: number } {
  const index = cellIndex(world, at);
  const { farthest, roadDistance } = world.layout;
  const distance = index < 0 ? 0 : (roadDistance[index] ?? 0);
  return {
    road: farthest === 0 ? 0 : Math.min(1, distance / farthest),
    across: Math.min(1, Math.max(0, at.x / world.W)),
  };
}

/**
 * How dangerous the world's places are. A spot's danger weight is
 * `(1 + road * r) * (1 + right * a)`, where `r` and `a` are its remoteness from the road and
 * across the world: 1 on the road at the left edge, up to `(1 + road) * (1 + right)` at the
 * farthest spot at the right.
 */
export interface DangerConfig {
  /** Extra weight at the farthest spot from the road; 0 makes distance from it count for nothing. */
  readonly road: number;
  /** Extra weight at the world's right edge, the exit's side; 0 makes neither side count. */
  readonly right: number;
}

/**
 * How much more dangerous `at` is than the safest spot, as a factor: 1 at the safest. Monsters
 * spawn in proportion to it.
 */
export function dangerWeight(world: World, at: Point): number {
  const { road, right } = world.layout.danger;
  const far = remoteness(world, at);
  return (1 + road * far.road) * (1 + right * far.across);
}

/** How dangerous `at` is, 0 (safest) to 1 (most dangerous): its danger weight, rescaled. */
export function danger(world: World, at: Point): number {
  const { road, right } = world.layout.danger;
  const most = (1 + road) * (1 + right) - 1;
  return most <= 0 ? 0 : (dangerWeight(world, at) - 1) / most;
}

/** Whether `at` lies within `rect`, edges included. */
export function inRect(rect: Rect, at: Point): boolean {
  return (
    at.x >= rect.x &&
    at.y >= rect.y &&
    at.x <= rect.x + rect.w &&
    at.y <= rect.y + rect.h
  );
}

export function isAreaFree(
  map: TileMap,
  x: number,
  y: number,
  half: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
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

/** Draws for a free spot in a box before giving up. */
const BOX_ATTEMPTS = 64;

/** A random free spot for a body of `clearance` half-size within `rect`, or null if none is found. */
export function randomFreePositionIn(
  world: World,
  rect: Rect,
  clearance: number,
  rng: Rng,
): Point | null {
  const w = Math.max(0, rect.w - clearance * 2);
  const h = Math.max(0, rect.h - clearance * 2);
  for (let attempt = 0; attempt < BOX_ATTEMPTS; attempt++) {
    const x = rect.x + clearance + rng() * w;
    const y = rect.y + clearance + rng() * h;
    if (isAreaFree(world.map, x, y, clearance)) return { x, y };
  }
  return null;
}
