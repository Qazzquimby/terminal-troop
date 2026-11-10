import { expect, test } from "vitest";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { emptyMap, mapWithCenterWall } from "../integration/tile-maps.js";
import type { TileMap } from "./map.js";
import { createSession } from "./session.js";
import type { VisibilityPolygon, VisionSource } from "./vision.js";
import {
  canSeeFrom,
  directionalVision,
  hasLineOfSight,
  isVisible,
  lightSources,
  litWalls,
  visibilityPolygon,
  visionOrigins,
  wallCell,
} from "./vision.js";

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

test("directional vision combines a cone with short omnidirectional sight", () => {
  const map = emptyMap();
  const sources = directionalVision(
    { x: 150, y: 150 },
    0,
    {
      coneAngle: Math.PI / 2,
      rays: 64,
      surroundingsRadius: 40,
    },
    100,
  );
  const visible = (x: number, y: number) =>
    sources.some((source) => canSeeFrom(map, source, { x, y }));

  expect(visible(110, 150)).toBe(true);
  expect(visible(109, 150)).toBe(false);
  expect(visible(250, 150)).toBe(true);
  expect(visible(251, 150)).toBe(false);
});

test("surroundings never exceed the viewer's sight range", () => {
  const sources = directionalVision(
    { x: 150, y: 150 },
    0,
    {
      coneAngle: Math.PI / 2,
      rays: 64,
      surroundingsRadius: 70,
    },
    20,
  );

  expect(
    sources.some((source) =>
      canSeeFrom(emptyMap(), source, { x: 130, y: 150 }),
    ),
  ).toBe(true);
  expect(
    sources.some((source) =>
      canSeeFrom(emptyMap(), source, { x: 129, y: 150 }),
    ),
  ).toBe(false);
});

test("walls block the omnidirectional part of directional vision", () => {
  const sources = directionalVision(
    { x: 175, y: 125 },
    0,
    {
      coneAngle: Math.PI / 2,
      rays: 64,
      surroundingsRadius: 150,
    },
  );

  expect(
    sources.some((source) =>
      canSeeFrom(mapWithCenterWall(), source, { x: 75, y: 125 }),
    ),
  ).toBe(false);
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

function cellsOf(map: TileMap, walls: VisibilityPolygon["walls"]) {
  return [...walls.keys()]
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
  expect(litWalls(seen, [short, above]).size).toBe(0);
  expect(
    cellsOf(
      map,
      litWalls(seen, [
        visibilityPolygon(map, { x: 75, y: 25, range: 150 }, 32),
      ]),
    ),
  ).toEqual([{ col: 2, row: 2 }]);
});

test("visible walls contain only their facing edge", () => {
  const map = mapWithCenterWall();
  const polygon = visibilityPolygon(map, { x: 75, y: 125, range: 60 }, 4);
  const faces = [...litWalls([polygon], [polygon]).values()].flat();

  expect(faces).toHaveLength(1);
  expect(faces[0]?.normal).toEqual({ x: -1, y: 0 });
  expect(faces[0]?.from.x).toBe(100);
  expect(faces[0]?.from.y).toBeCloseTo(100);
  expect(faces[0]?.to.x).toBe(100);
  expect(faces[0]?.to.y).toBeCloseTo(150);
});

test("lighting the opposite face does not reveal a wall", () => {
  const map = mapWithCenterWall();
  const seen = visibilityPolygon(map, { x: 75, y: 125, range: 60 }, 4);
  const lit = visibilityPolygon(map, { x: 175, y: 125, range: 60 }, 4);

  expect(litWalls([seen], [lit]).size).toBe(0);
});

test("only the illuminated portion of a visible wall face is revealed", () => {
  const map = mapWithCenterWall();
  const seen = visibilityPolygon(map, { x: 75, y: 125, range: 60 }, 4);
  const lit = visibilityPolygon(map, { x: 75, y: 100, range: 30 }, 4);
  const faces = [...litWalls([seen], [lit]).values()].flat();

  expect(faces).toHaveLength(1);
  expect(faces[0]?.from.x).toBe(100);
  expect(faces[0]?.from.y).toBeCloseTo(100);
  expect(faces[0]?.to.x).toBe(100);
  expect(faces[0]?.to.y).toBeCloseTo(100 + Math.sqrt(30 ** 2 - 25 ** 2));
});

test("a short range reveals an edge even when neither tile corner is in range", () => {
  const map = mapWithCenterWall();
  const polygon = visibilityPolygon(map, { x: 99, y: 125, range: 2 }, 4);
  const faces = [...litWalls([polygon], [polygon]).values()].flat();

  expect(faces).toHaveLength(1);
  expect(faces[0]?.from.x).toBe(100);
  expect(faces[0]?.from.y).toBeCloseTo(125 - Math.sqrt(3));
  expect(faces[0]?.to.x).toBe(100);
  expect(faces[0]?.to.y).toBeCloseTo(125 + Math.sqrt(3));
});

function longWallMap(): TileMap {
  const cols = 8;
  const rows = 10;
  const solid = new Uint8Array(cols * rows);
  for (let row = 1; row <= 8; row++) solid[row * cols + 4] = 1;
  return { cell: 50, cols, rows, solid };
}

test("long wall edges stay continuous as the viewer turns with few regular rays", () => {
  const map = longWallMap();

  for (const direction of [-0.02, 0, 0.02]) {
    const polygon = visibilityPolygon(
      map,
      {
        x: 75,
        y: 225,
        range: 400,
        shape: { kind: "cone", direction, angle: Math.PI },
      },
      4,
    );
    const walls = litWalls([polygon], [polygon]);
    const cells = cellsOf(map, walls).filter(
      ({ col, row }) => col === 4 && row >= 0 && row < map.rows,
    );
    expect(cells.map(({ row }) => row)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (const [key, faces] of walls) {
      const { col, row } = wallCell(map, key);
      if (col !== 4 || row < 1 || row > 8) continue;

      expect(faces).toHaveLength(1);
      expect(faces[0]?.normal).toEqual({ x: -1, y: 0 });
      expect(faces[0]?.from.x).toBe(200);
      expect(faces[0]?.from.y).toBeCloseTo(row * map.cell);
      expect(faces[0]?.to.x).toBe(200);
      expect(faces[0]?.to.y).toBeCloseTo((row + 1) * map.cell);
    }
  }
});

test("continuous wall edges do not bridge an occluding obstacle", () => {
  const map = longWallMap();
  map.solid[4 * map.cols + 2] = 1;
  const polygon = visibilityPolygon(
    map,
    { x: 75, y: 225, range: 400 },
    4,
  );
  const walls = litWalls([polygon], [polygon]);
  const hidden = cellsOf(map, walls).filter(
    ({ col, row }) => col === 4 && row >= 2 && row <= 6,
  );

  expect(hidden).toEqual([]);
  expect(cellsOf(map, walls)).toContainEqual({ col: 4, row: 1 });
  expect(cellsOf(map, walls)).toContainEqual({ col: 4, row: 8 });
});

const SURROUNDINGS = 70;

function viewerFacingRight(map: TileMap, x: number, y: number) {
  const game = createSession("me", "ME", "LIGHT", "dev", testSfx(), {
    ...testSimConfig,
    vision: {
      coneAngle: Math.PI / 2,
      rays: 64,
      surroundingsRadius: SURROUNDINGS,
    },
  });
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

  expect(visible({ x: 150 - SURROUNDINGS + 5, y: 150 })).toBe(true);
  expect(visible({ x: 150 - SURROUNDINGS - 5, y: 150 })).toBe(false);
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
