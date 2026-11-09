import type { TileMap } from "../sim/index.js";

export function emptyMap(): TileMap {
  return { cell: 50, cols: 6, rows: 6, solid: new Uint8Array(36) };
}

export function mapWithCenterWall(): TileMap {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;
  return map;
}
