import { z } from "zod";
import type {
  Point,
  TileMap,
  VisibilityPolygon,
  WorldKind,
} from "../sim/index.js";

/** How remembered terrain is drawn and kept. */
export interface MapMemoryConfig {
  /** How often, in seconds, newly seen terrain is saved while it keeps changing. */
  readonly saveInterval: number;
  /** How many of the most recently entered worlds are kept in storage; older ones are deleted. */
  readonly maxRooms: number;
  /** Remembered floor: each cell filled and outlined, at `alpha`. */
  readonly floor: {
    readonly fill: string;
    readonly grid: string;
    readonly alpha: number;
  };
  /** Remembered walls: a band along each face, at `alpha`. */
  readonly wall: {
    readonly fill: string;
    readonly edge: string;
    readonly alpha: number;
  };
}

/** Where remembered terrain is kept between visits, by key. Either method may throw. */
export interface MapMemoryStorage {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
}

/** The storage key of the saved worlds' keys, most recently entered first. */
export const MAP_MEMORY_INDEX = "terminal-troop:map-memory:index";

const IndexSchema = z.array(z.string());

/** A world as a room builds it: the same room code and world kind always build the same map. */
export interface MapPlace {
  readonly room: string;
  readonly world: WorldKind;
  /** The session's seed, which covers the room code and the world config's seed. */
  readonly seed: number;
}

/** What the local player sees in one frame, as traced for drawing it. */
export interface Sight {
  /** Vision polygons: what the player is looking at. */
  readonly seen: readonly VisibilityPolygon[];
  /** Light polygons: floor counts as seen only where it is inside both kinds. */
  readonly lit: readonly VisibilityPolygon[];
  /** The wall cells with a face both seen and lit. */
  readonly walls: VisibilityPolygon["walls"];
}

/** A rectangle of the world, in pixels. */
export interface Area extends Point {
  readonly width: number;
  readonly height: number;
}

/** A remembered stretch of terrain, ready to draw. */
export interface RememberedTerrain {
  /** Floor cells, as their top-left corners. */
  readonly floor: readonly Point[];
  /** Faces of remembered walls that look onto remembered floor. */
  readonly walls: VisibilityPolygon["walls"];
}

/** The terrain the local player has seen in the current world, kept on this client alone. */
export interface MapMemory {
  readonly config: MapMemoryConfig;
  /**
   * Saves what is remembered of the world left, then remembers `map` at `place`, starting from
   * what was saved for it, or from nothing.
   */
  enter(place: MapPlace, map: TileMap): void;
  /** Remembers the floor and wall cells `sight` reaches within `view`. */
  see(sight: Sight, view: Area): void;
  /** The remembered terrain within `view`. */
  within(view: Area): RememberedTerrain;
  /** Saves what is newly remembered, unless it was saved under `saveInterval` before `now` (ms). */
  save(now: number): void;
  /** Saves what is newly remembered now, as when the page closes. */
  flush(): void;
}

/** The storage key for what is remembered of the world at `place` with `map`'s size. */
export function mapMemoryKey(place: MapPlace, map: TileMap): string {
  return `terminal-troop:map-memory:${place.world}:${place.room}:${String(place.seed)}:${String(map.cols)}x${String(map.rows)}`;
}

/**
 * One bit per cell of `map` padded by a cell on every side, so the solid ring round the world
 * can be remembered too. Cells are numbered row-major over the padded map, as wall keys are.
 */
class Grid {
  readonly bits: Uint8Array;
  readonly stride: number;

  constructor(
    readonly map: TileMap,
    bits?: Uint8Array,
  ) {
    this.stride = map.cols + 2;
    this.bits = bits ?? new Uint8Array(Grid.bytes(map));
  }

  static bytes(map: TileMap): number {
    return Math.ceil(((map.cols + 2) * (map.rows + 2)) / 8);
  }

  key(col: number, row: number): number {
    return (row + 1) * this.stride + col + 1;
  }

  has(key: number): boolean {
    return ((this.bits[key >> 3] ?? 0) & (1 << (key & 7))) !== 0;
  }

  /** Whether `key` was newly marked. */
  mark(key: number): boolean {
    if (key < 0 || key >= this.stride * (this.map.rows + 2) || this.has(key))
      return false;
    this.bits[key >> 3] = (this.bits[key >> 3] ?? 0) | (1 << (key & 7));
    return true;
  }

  solid(col: number, row: number): boolean {
    const { cols, rows, solid } = this.map;
    if (col < 0 || row < 0 || col >= cols || row >= rows) return true;
    return solid[row * cols + col] === 1;
  }

  /** The cells, padding included, that `area` overlaps. */
  span(area: Area): {
    minCol: number;
    maxCol: number;
    minRow: number;
    maxRow: number;
  } {
    const { cell, cols, rows } = this.map;
    return {
      minCol: Math.max(-1, Math.floor(area.x / cell)),
      maxCol: Math.min(cols, Math.floor((area.x + area.width) / cell)),
      minRow: Math.max(-1, Math.floor(area.y / cell)),
      maxRow: Math.min(rows, Math.floor((area.y + area.height) / cell)),
    };
  }
}

function encode(bits: Uint8Array): string {
  return btoa(String.fromCharCode(...bits));
}

function decode(text: string, bytes: number): Uint8Array | null {
  const raw = atob(text);
  if (raw.length !== bytes) return null;
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Where `area` and `bounds` overlap; a negative width or height when they don't. */
function overlap(area: Area, bounds: Bounds): Area {
  const x = Math.max(area.x, bounds.minX);
  const y = Math.max(area.y, bounds.minY);
  return {
    x,
    y,
    width: Math.min(area.x + area.width, bounds.maxX) - x,
    height: Math.min(area.y + area.height, bounds.maxY) - y,
  };
}

/**
 * A visibility polygon's outline, for testing many points against it. Where it crosses each
 * height tested is worked out once, so a row of points costs one pass over its edges.
 */
class Outline implements Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  private readonly crossings = new Map<number, number[]>();

  constructor(private readonly points: readonly Point[]) {
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    this.minX = Math.min(...xs);
    this.minY = Math.min(...ys);
    this.maxX = Math.max(...xs);
    this.maxY = Math.max(...ys);
  }

  /** Even-odd: whether `point` has an odd number of crossings to its left. */
  contains(point: Point): boolean {
    if (
      point.x < this.minX ||
      point.x > this.maxX ||
      point.y < this.minY ||
      point.y > this.maxY
    )
      return false;
    const left = this.crossingsAt(point.y).filter((x) => x < point.x);
    return left.length % 2 === 1;
  }

  private crossingsAt(y: number): number[] {
    const known = this.crossings.get(y);
    if (known !== undefined) return known;
    const { points } = this;
    const found: number[] = [];
    points.forEach((a, i) => {
      const b = points[(i + points.length - 1) % points.length] ?? a;
      if (a.y > y !== b.y > y)
        found.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
    });
    this.crossings.set(y, found);
    return found;
  }
}

/** Where in a cell, as fractions of its side, floor is tested for being seen. */
const SAMPLES = [
  [0.5, 0.5],
  [0.15, 0.15],
  [0.85, 0.15],
  [0.15, 0.85],
  [0.85, 0.85],
] as const;

/** The four sides of a cell, as the step to the neighbour across each. */
const SIDES = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
] as const;

/**
 * Remembers nothing until it enters a world. Reads and writes through `storage` never stop the
 * game: a failed read starts from nothing, and a failed write keeps what is remembered in memory.
 */
export function createMapMemory(
  config: MapMemoryConfig,
  storage: MapMemoryStorage,
): MapMemory {
  let grid: Grid | null = null;
  let key = "";
  let dirty = false;
  let nextSaveAt = 0;

  function write(): void {
    if (grid === null || !dirty) return;
    dirty = false;
    try {
      storage.set(key, encode(grid.bits));
    } catch {
      // Remembered for this visit only.
    }
  }

  function read(map: TileMap): Uint8Array | undefined {
    try {
      const saved = storage.get(key);
      return (
        (saved === null ? null : decode(saved, Grid.bytes(map))) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  /** The saved worlds' keys, most recent first; none if the index is missing or unreadable. */
  function readIndex(): string[] {
    try {
      const raw = storage.get(MAP_MEMORY_INDEX);
      if (raw === null) return [];
      const parsed = IndexSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  /** Puts `key` first in the index, and deletes the worlds that fall past `maxRooms`. */
  function touch(): void {
    const order = [key, ...readIndex().filter((other) => other !== key)];
    try {
      for (const old of order.slice(config.maxRooms)) storage.remove(old);
      storage.set(
        MAP_MEMORY_INDEX,
        JSON.stringify(order.slice(0, config.maxRooms)),
      );
    } catch {
      // Tried again on the next world entered.
    }
  }

  return {
    config,
    enter(place, map) {
      write();
      key = mapMemoryKey(place, map);
      touch();
      grid = new Grid(map, read(map));
      dirty = false;
      nextSaveAt = 0;
    },
    see({ seen, lit, walls }, view) {
      if (grid === null) return;
      const memory = grid;
      for (const wall of walls.keys()) dirty = memory.mark(wall) || dirty;

      const outline = ({ points }: VisibilityPolygon) => new Outline(points);
      const seenShapes = seen.map(outline);
      const { cell } = memory.map;
      for (const light of lit.map(outline)) {
        const { minCol, maxCol, minRow, maxRow } = memory.span(
          overlap(view, light),
        );
        for (let row = minRow; row <= maxRow; row++) {
          for (let col = minCol; col <= maxCol; col++) {
            const cellKey = memory.key(col, row);
            if (memory.solid(col, row) || memory.has(cellKey)) continue;
            const visible = SAMPLES.some(([fx, fy]) => {
              const point = { x: (col + fx) * cell, y: (row + fy) * cell };
              return (
                light.contains(point) &&
                seenShapes.some((shape) => shape.contains(point))
              );
            });
            if (visible) dirty = memory.mark(cellKey) || dirty;
          }
        }
      }
    },
    within(view) {
      const floor: Point[] = [];
      const walls = new Map<number, Face[]>();
      if (grid === null) return { floor, walls };
      const memory = grid;
      const { cell } = memory.map;
      const { minCol, maxCol, minRow, maxRow } = memory.span(view);
      for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
          const cellKey = memory.key(col, row);
          if (!memory.has(cellKey)) continue;
          if (!memory.solid(col, row)) {
            floor.push({ x: col * cell, y: row * cell });
            continue;
          }
          const faces = SIDES.filter(
            (side) =>
              !memory.solid(col + side.x, row + side.y) &&
              memory.has(memory.key(col + side.x, row + side.y)),
          ).map((normal) => face(col, row, normal, cell));
          if (faces.length > 0) walls.set(cellKey, faces);
        }
      }
      return { floor, walls };
    },
    save(now) {
      if (!dirty || now < nextSaveAt) return;
      write();
      nextSaveAt = now + config.saveInterval * 1000;
    },
    flush: write,
  };
}

interface Face {
  readonly from: Point;
  readonly to: Point;
  /** Points out of the wall. */
  readonly normal: Point;
}

/** The side of wall cell (`col`, `row`) that faces out along `normal`. */
function face(col: number, row: number, normal: Point, cell: number): Face {
  const x = normal.x > 0 ? (col + 1) * cell : col * cell;
  const y = normal.y > 0 ? (row + 1) * cell : row * cell;
  return normal.x === 0
    ? { from: { x: col * cell, y }, to: { x: (col + 1) * cell, y }, normal }
    : { from: { x, y: row * cell }, to: { x, y: (row + 1) * cell }, normal };
}
