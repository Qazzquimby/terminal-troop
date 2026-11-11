import type { TileMap } from "../sim/index.js";

export const CELL_SIZE = 50;

export function emptyMap(): TileMap {
  return { cell: CELL_SIZE, cols: 6, rows: 6, solid: new Uint8Array(36) };
}

export function mapWithCenterWall(): TileMap {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;
  return map;
}
