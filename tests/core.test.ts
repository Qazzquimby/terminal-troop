import { expect, test } from "vitest";
import { createCamera, updateCamera } from "../src/engine/camera.js";
import { VIEW_H, VIEW_W } from "../src/engine/config.js";
import { moveWithCollision } from "../src/engine/collision.js";
import type { TileMap } from "../src/engine/map.js";
import { createMap, isAreaFree, mulberry32 } from "../src/engine/map.js";
import { hasLineOfSight } from "../src/engine/vision.js";

function emptyMap(): TileMap {
  return { cell: 50, cols: 6, rows: 6, solid: new Uint8Array(36) };
}

function mapWithCenterWall(): TileMap {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;
  return map;
}

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera();
  updateCamera(camera, { x: 14, y: 14 });
  expect(camera).toEqual({ x: 14 - VIEW_W / 2, y: 14 - VIEW_H / 2 });
});

test("map generation is reproducible from a seed", () => {
  const first = createMap(40, 30, mulberry32(123));
  const second = createMap(40, 30, mulberry32(123));
  expect(first.solid).toEqual(second.solid);
});

test("map occupancy rejects walls and world boundaries", () => {
  const map = mapWithCenterWall();
  expect(isAreaFree(map, 75, 75, 14)).toBe(true);
  expect(isAreaFree(map, 125, 125, 14)).toBe(false);
  expect(isAreaFree(map, 0, 75, 14)).toBe(false);
});

test("wall movement stops at the collision face", () => {
  const map = mapWithCenterWall();
  const body = { x: 85, y: 125, vx: 220, vy: 0 };

  moveWithCollision(body, 14, 1 / 60, map);

  expect(body.x).toBe(86);
  expect(Math.abs(body.vx)).toBe(0);
  expect(isAreaFree(map, body.x, body.y, 14)).toBe(true);
});

test("visibility is blocked by walls", () => {
  const map = mapWithCenterWall();
  expect(hasLineOfSight(map, { x: 75, y: 125 }, { x: 175, y: 125 })).toBe(
    false,
  );
  expect(hasLineOfSight(map, { x: 75, y: 75 }, { x: 175, y: 75 })).toBe(true);
});
