import { z } from "zod";
import type { Point, TileMap } from "./map.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * A patch of the world to knock walls down in: a circle, or the square a body of half-size
 * `radius` fills, as bodies meet walls.
 */
export interface WallArea {
  readonly center: Point;
  readonly radius: number;
  /** "circle" when left out. */
  readonly shape?: "circle" | "square";
}

/**
 * Every wall cell knocked down since the world was laid, row-major indices, oldest first. The
 * host adds to it; every client holds it and clears those cells from its map, so a late joiner
 * and the next host see the same walls.
 */
export const destroyedWalls = worldData({
  schema: z.array(z.number().int().min(0)),
  initial: [],
});

/** Margin, in pixels, a cell must reach past an area's edge to count as in it. */
const EPSILON = 1e-6;

/** Whether the cell at (`col`, `row`) of `map` overlaps `area`. */
function cellOverlaps(
  map: TileMap,
  col: number,
  row: number,
  area: WallArea,
): boolean {
  const { cell } = map;
  const { center, radius } = area;
  const nearX = Math.max(col * cell, Math.min(center.x, (col + 1) * cell));
  const nearY = Math.max(row * cell, Math.min(center.y, (row + 1) * cell));
  if (area.shape === "square")
    return (
      Math.abs(nearX - center.x) < radius - EPSILON &&
      Math.abs(nearY - center.y) < radius - EPSILON
    );
  return Math.hypot(nearX - center.x, nearY - center.y) < radius - EPSILON;
}

/** The wall cells of `map` that overlap `area`, row-major indices; the edge of the world is none. */
export function wallCellsIn(map: TileMap, area: WallArea): number[] {
  const { cell, cols, rows } = map;
  const { center, radius } = area;
  const minCol = Math.max(0, Math.floor((center.x - radius) / cell));
  const maxCol = Math.min(cols - 1, Math.floor((center.x + radius) / cell));
  const minRow = Math.max(0, Math.floor((center.y - radius) / cell));
  const maxRow = Math.min(rows - 1, Math.floor((center.y + radius) / cell));
  const cells: number[] = [];
  for (let row = minRow; row <= maxRow; row++)
    for (let col = minCol; col <= maxCol; col++) {
      const index = row * cols + col;
      if (map.solid[index] === 1 && cellOverlaps(map, col, row, area))
        cells.push(index);
    }
  return cells;
}

/** The world entry's wire value each session last cleared its map by. */
const followed = new WeakMap<Session, unknown>();

/** Clears every cell in `cells` from `map`. */
function clear(map: TileMap, cells: readonly number[]): void {
  for (const index of cells) if (index < map.solid.length) map.solid[index] = 0;
}

/**
 * Knocks down every wall cell that overlaps `area`, which only the host does: its map at once,
 * and every other client's as the world state reaches it. Returns how many cells came down; 0 on
 * any other client.
 */
export function destroyWalls(game: Session, area: WallArea): number {
  if (!game.hosting) return 0;
  const { map } = game.world;
  const cells = wallCellsIn(map, area);
  if (cells.length === 0) return 0;
  clear(map, cells);
  destroyedWalls.set(game, [...destroyedWalls.get(game), ...cells]);
  return cells.length;
}

/** Clears the walls the world state says are down from this client's map, once each change. */
export function followWalls(game: Session): void {
  const wire = game.worldValues.get(destroyedWalls)?.wire;
  if (wire === undefined || followed.get(game) === wire) return;
  followed.set(game, wire);
  clear(game.world.map, destroyedWalls.get(game));
}
