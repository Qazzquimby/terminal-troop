import test from "node:test";
import assert from "node:assert/strict";
import { createCamera, updateCamera } from "../src/engine/camera.js";
import { VIEW_H, VIEW_W } from "../src/engine/config.js";
import { moveWithCollision } from "../src/engine/collision.js";
import {
  createMap,
  isAreaFree,
  mulberry32,
} from "../src/engine/map.js";
import { hasLineOfSight } from "../src/engine/vision.js";

function emptyMap() {
  return {
    cell: 50,
    cols: 6,
    rows: 6,
    solid: new Uint8Array(36),
  };
}

test("camera centers its target even at the world boundary", () => {
  const camera = createCamera();
  updateCamera(camera, { x: 14, y: 14 });
  assert.equal(camera.x, 14 - VIEW_W / 2);
  assert.equal(camera.y, 14 - VIEW_H / 2);
});

test("map generation is reproducible from a seed", () => {
  const first = createMap(40, 30, mulberry32(123));
  const second = createMap(40, 30, mulberry32(123));
  assert.deepEqual(first.solid, second.solid);
});

test("map occupancy rejects walls and world boundaries", () => {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;

  assert.equal(isAreaFree(map, 75, 75, 14), true);
  assert.equal(isAreaFree(map, 125, 125, 14), false);
  assert.equal(isAreaFree(map, 0, 75, 14), false);
});

test("wall movement stops at the collision face", () => {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;
  const body = { x: 85, y: 125, vx: 220, vy: 0 };

  moveWithCollision(body, 14, 1 / 60, map);

  assert.equal(body.x, 86);
  assert.equal(Math.abs(body.vx), 0);
  assert.equal(isAreaFree(map, body.x, body.y, 14), true);
});

test("visibility is blocked by walls", () => {
  const map = emptyMap();
  map.solid[2 * map.cols + 2] = 1;

  assert.equal(
    hasLineOfSight(map, { x: 75, y: 125 }, { x: 175, y: 125 }),
    false,
  );
  assert.equal(
    hasLineOfSight(map, { x: 75, y: 75 }, { x: 175, y: 75 }),
    true,
  );
});
