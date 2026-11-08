import { expect, test } from "vitest";
import { createCamera, updateCamera } from "../src/engine/camera.js";
import { createSfx } from "../src/engine/audio.js";
import {
  PLAYER_SURROUNDINGS_RADIUS,
  VIEW_H,
  VIEW_W,
} from "../src/engine/config.js";
import { moveWithCollision } from "../src/engine/collision.js";
import type { TileMap } from "../src/engine/map.js";
import { createMap, isAreaFree, mulberry32 } from "../src/engine/map.js";
import { createSession } from "../src/engine/session.js";
import type { VisionSource } from "../src/engine/vision.js";
import {
  canSeeFrom,
  hasLineOfSight,
  isVisible,
  lightSources,
  litWalls,
  visibilityPolygon,
  visionOrigins,
  wallCell,
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

  const { points } = visibilityPolygon(emptyMap(), source, 8, 100);

  expect(points).toHaveLength(4);
  expect(points[0]).toEqual({ x: 150, y: 150 });
  expect(points[1]?.x).toBeCloseTo(150 + 40 / Math.sqrt(2));
  expect(points[1]?.y).toBeCloseTo(150 - 40 / Math.sqrt(2));
  expect(points[2]).toEqual({ x: 190, y: 150 });
  expect(points[3]?.x).toBeCloseTo(150 + 40 / Math.sqrt(2));
  expect(points[3]?.y).toBeCloseTo(150 + 40 / Math.sqrt(2));
});

test("omnidirectional polygons retain the full circle", () => {
  const { points } = visibilityPolygon(
    emptyMap(),
    { x: 150, y: 150, shape: { kind: "omnidirectional" }, range: 40 },
    4,
  );

  expect(points).toHaveLength(4);
  expect(points[0]).toEqual({ x: 190, y: 150 });
  expect(points[2]?.x).toBeCloseTo(110);
  expect(points[2]?.y).toBeCloseTo(150);
});

test("visibility requires both vision and illumination", () => {
  const map = emptyMap();
  const source: VisionSource = {
    x: 75,
    y: 125,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
  };
  const lights = [{ x: 75, y: 125, range: 50 }];

  expect(isVisible(map, [source], [], { x: 100, y: 125 })).toBe(false);
  expect(isVisible(map, [], lights, { x: 100, y: 125 })).toBe(false);
  expect(isVisible(map, [source], lights, { x: 100, y: 125 })).toBe(true);
  expect(isVisible(map, [source], lights, { x: 150, y: 125 })).toBe(false);
  expect(isVisible(map, [source], lights, { x: 50, y: 125 })).toBe(false);
});

test("a narrow light extends illumination without widening vision", () => {
  const source: VisionSource = {
    x: 75,
    y: 150,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
  };
  const innate = { ...source, range: 40 };
  const flashlight = {
    x: source.x,
    y: source.y,
    shape: { kind: "cone" as const, direction: 0, angle: Math.PI / 6 },
    range: 150,
  };
  const map = emptyMap();

  expect(isVisible(map, [source], [innate], { x: 175, y: 150 })).toBe(false);
  expect(
    isVisible(map, [source], [innate, flashlight], { x: 175, y: 150 }),
  ).toBe(true);
  expect(
    isVisible(map, [source], [innate, flashlight], { x: 175, y: 200 }),
  ).toBe(false);
});

test("walls can block illumination without blocking the viewer", () => {
  const map = mapWithCenterWall();
  const source = { x: 175, y: 75 };
  const light = { x: 75, y: 125, range: 250 };
  const point = { x: 175, y: 125 };

  expect(canSeeFrom(map, source, point)).toBe(true);
  expect(isVisible(map, [source], [light], point)).toBe(false);
  expect(
    isVisible(map, [source], [light, { ...point, range: 25 }], point),
  ).toBe(true);
});

test("rays cannot leak through a wall corner in either direction", () => {
  const map = mapWithCenterWall();
  const first = { x: 75, y: 125 };
  const second = { x: 125, y: 75 };

  expect(hasLineOfSight(map, first, second)).toBe(false);
  expect(hasLineOfSight(map, second, first)).toBe(false);
});

test("visibility polygons sample obstacle corners between regular rays", () => {
  const source: VisionSource = {
    x: 75,
    y: 125,
    range: 150,
    shape: { kind: "cone", direction: 0, angle: Math.PI / 2 },
  };

  const { points } = visibilityPolygon(mapWithCenterWall(), source, 8);
  const cornerAngle = Math.atan2(-25, 75);
  const nearCorner = points.filter((point) => {
    const dx = point.x - source.x;
    const dy = point.y - source.y;
    return (
      Math.hypot(dx, dy) > 0 &&
      Math.abs(Math.atan2(dy, dx) - cornerAngle) < 1e-6
    );
  });

  expect(nearCorner.length).toBeGreaterThanOrEqual(3);
});

function cellsOf(map: TileMap, walls: Iterable<number>) {
  return [...walls]
    .map((key) => wallCell(map, key))
    .sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row));
}

test("polygons report the wall cells their rays stop on", () => {
  const map = mapWithCenterWall();
  const source = { x: 75, y: 125, range: 76 };

  const { walls } = visibilityPolygon(map, source, 64);

  expect(cellsOf(map, walls)).toEqual([
    { col: -1, row: 2 },
    { col: 2, row: 2 },
  ]);
});

test("a wall is lit only where a lit ray and a seeing ray both reach it", () => {
  const map = mapWithCenterWall();
  const cone = { kind: "cone" as const, direction: 0, angle: Math.PI / 2 };
  const seen = [visibilityPolygon(map, { x: 75, y: 125, shape: cone }, 32)];
  const near = visibilityPolygon(map, { x: 75, y: 125, range: 50 }, 32);
  const short = visibilityPolygon(map, { x: 75, y: 125, range: 20 }, 32);
  const above = visibilityPolygon(map, { x: 125, y: 25, range: 100 }, 32);

  expect(cellsOf(map, litWalls(seen, [near]))).toEqual([{ col: 2, row: 2 }]);
  expect(litWalls(seen, [short]).size).toBe(0);
  expect(litWalls([], [near]).size).toBe(0);
  expect(cellsOf(map, litWalls(seen, [short, above]))).toEqual([
    { col: 2, row: 2 },
  ]);
});

function viewerFacingRight(map: TileMap, x: number, y: number) {
  const game = createSession("me", "ME", "LIGHT", "dev", createSfx());
  const viewer = { id: "me", x, y, aim: 0 };
  const sources = visionOrigins(game, viewer);
  const lights = lightSources(game, viewer);
  return {
    visible: (point: { x: number; y: number }) =>
      isVisible(map, sources, lights, point),
    litWalls: () =>
      litWalls(
        sources.map((source) => visibilityPolygon(map, source, 64)),
        lights.map((light) => visibilityPolygon(map, light, 64)),
      ),
  };
}

test("the circle around the player reveals what is just behind them", () => {
  const { visible } = viewerFacingRight(emptyMap(), 150, 150);

  expect(visible({ x: 150 - PLAYER_SURROUNDINGS_RADIUS + 5, y: 150 })).toBe(
    true,
  );
  expect(visible({ x: 150 - PLAYER_SURROUNDINGS_RADIUS - 5, y: 150 })).toBe(
    false,
  );
});

test("the circle around the player lights a wall behind them", () => {
  const map = mapWithCenterWall();
  const viewer = viewerFacingRight(map, 175, 125);

  const behind = cellsOf(map, viewer.litWalls()).filter(({ col }) => col < 3);

  expect(behind).toEqual([{ col: 2, row: 2 }]);
});

test("visibility is blocked by walls", () => {
  const map = mapWithCenterWall();
  expect(hasLineOfSight(map, { x: 75, y: 125 }, { x: 175, y: 125 })).toBe(
    false,
  );
  expect(hasLineOfSight(map, { x: 75, y: 75 }, { x: 175, y: 75 })).toBe(true);
});
