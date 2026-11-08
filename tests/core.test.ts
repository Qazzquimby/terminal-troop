import { expect, test } from "vitest";
import { createCamera, updateCamera } from "../src/engine/camera.js";
import { VIEW_H, VIEW_W } from "../src/engine/config.js";
import { moveWithCollision } from "../src/engine/collision.js";
import type { TileMap } from "../src/engine/map.js";
import { createMap, isAreaFree, mulberry32 } from "../src/engine/map.js";
import type { VisionSource } from "../src/engine/vision.js";
import {
  canSeeFrom,
  hasLineOfSight,
  visibilityPolygon,
} from "../src/engine/vision.js";

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
  updateCamera(camera, { x: 14, y: 14 }, { W: 8000, H: 6000 });
  expect(camera).toEqual({ x: 14 - VIEW_W / 2, y: 14 - VIEW_H / 2 });
});

test("camera centres a world that fits the view", () => {
  const camera = createCamera();
  updateCamera(camera, { x: 14, y: 14 }, { W: VIEW_W, H: VIEW_H });
  expect(camera).toEqual({ x: 0, y: 0 });
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

test("cone vision includes its edges but excludes points behind it", () => {
  const map = emptyMap();
  const source: VisionSource = {
    x: 75,
    y: 75,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
  };

  expect(canSeeFrom(map, source, source)).toBe(true);
  expect(canSeeFrom(map, source, { x: 125, y: 75 })).toBe(true);
  expect(canSeeFrom(map, source, { x: 125, y: 125 })).toBe(true);
  expect(canSeeFrom(map, source, { x: 125, y: 25 })).toBe(true);
  expect(canSeeFrom(map, source, { x: 25, y: 75 })).toBe(false);
  expect(canSeeFrom(map, source, { x: 75, y: 125 })).toBe(false);
});

test("cone vision handles directions across the angle wraparound", () => {
  const source: VisionSource = {
    x: 150,
    y: 150,
    shape: { kind: "cone", direction: Math.PI - 0.1, angle: Math.PI / 2 },
  };

  expect(canSeeFrom(emptyMap(), source, { x: 100, y: 140 })).toBe(true);
  expect(canSeeFrom(emptyMap(), source, { x: 200, y: 150 })).toBe(false);
});

test("cone vision remains blocked by walls", () => {
  const source: VisionSource = {
    x: 75,
    y: 125,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
  };

  expect(canSeeFrom(mapWithCenterWall(), source, { x: 175, y: 125 })).toBe(
    false,
  );
});

test("omnidirectional vision supports an independent range", () => {
  const source: VisionSource = {
    x: 150,
    y: 150,
    shape: { kind: "omnidirectional" },
    range: 50,
  };

  expect(canSeeFrom(emptyMap(), source, { x: 100, y: 150 })).toBe(true);
  expect(canSeeFrom(emptyMap(), source, { x: 200, y: 150 })).toBe(true);
  expect(canSeeFrom(emptyMap(), source, { x: 201, y: 150 })).toBe(false);
  expect(canSeeFrom(emptyMap(), { x: 150, y: 150 }, { x: 25, y: 150 })).toBe(
    true,
  );
});

test("cone polygons include the origin and both boundary rays", () => {
  const source: VisionSource = {
    x: 150,
    y: 150,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
    range: 40,
  };

  const points = visibilityPolygon(emptyMap(), source, 8, 100);

  expect(points).toHaveLength(4);
  expect(points[0]).toEqual({ x: 150, y: 150 });
  expect(points[1]?.x).toBeCloseTo(150 + 40 / Math.sqrt(2));
  expect(points[1]?.y).toBeCloseTo(150 - 40 / Math.sqrt(2));
  expect(points[2]).toEqual({ x: 190, y: 150 });
  expect(points[3]?.x).toBeCloseTo(150 + 40 / Math.sqrt(2));
  expect(points[3]?.y).toBeCloseTo(150 + 40 / Math.sqrt(2));
});

test("omnidirectional polygons retain the full circle", () => {
  const points = visibilityPolygon(
    emptyMap(),
    { x: 150, y: 150, shape: { kind: "omnidirectional" }, range: 40 },
    4,
  );

  expect(points).toHaveLength(4);
  expect(points[0]).toEqual({ x: 190, y: 150 });
  expect(points[2]?.x).toBeCloseTo(110);
  expect(points[2]?.y).toBeCloseTo(150);
});

test("visibility is blocked by walls", () => {
  const map = mapWithCenterWall();
  expect(hasLineOfSight(map, { x: 75, y: 125 }, { x: 175, y: 125 })).toBe(
    false,
  );
  expect(hasLineOfSight(map, { x: 75, y: 75 }, { x: 175, y: 75 })).toBe(true);
});
