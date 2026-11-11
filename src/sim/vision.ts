import type { Point, TileMap } from "./map.js";
import { isSolid } from "./map.js";
import type { Session } from "./session.js";

/** How a player sees. */
export interface VisionConfig {
  /** Width of the view cone, in radians. */
  readonly coneAngle: number;
  /** Rays cast around a full circle when tracing what a source reaches. */
  readonly rays: number;
  /** Radius of the circle around the player that is always seen and lit, behind them too. */
  readonly surroundingsRadius: number;
}

/** The light a player carries. */
export interface LightConfig {
  /** How far the light reaches along the view cone, in pixels. */
  readonly range: number;
}

type VisionShape =
  | { readonly kind: "omnidirectional" }
  | {
      readonly kind: "cone";
      readonly direction: number;
      readonly angle: number;
    };

export interface VisionSource extends Point {
  readonly shape?: VisionShape;
  readonly range?: number;
}

export interface LightEmission {
  readonly shape?: VisionShape;
  readonly range: number;
}

export interface LightSource extends Point, LightEmission {}

interface Viewer extends Point {
  readonly id: string;
  readonly aim: number;
}

function withinVision(source: VisionSource, point: Point): boolean {
  const dx = point.x - source.x;
  const dy = point.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance > (source.range ?? Infinity)) return false;
  if (distance === 0 || source.shape?.kind !== "cone") return true;

  const difference = Math.atan2(dy, dx) - source.shape.direction;
  const angle = Math.atan2(Math.sin(difference), Math.cos(difference));
  return Math.abs(angle) <= source.shape.angle / 2;
}

export function canSeeFrom(
  map: TileMap,
  source: VisionSource,
  point: Point,
): boolean {
  return withinVision(source, point) && hasLineOfSight(map, source, point);
}

/**
 * Identifies a wall cell. Rays can stop on the solid ring just outside the map, so cells are
 * numbered row-major over the map padded by one cell on every side.
 */
type WallKey = number;

export function wallCell(
  map: TileMap,
  key: WallKey,
): { readonly col: number; readonly row: number } {
  const stride = map.cols + 2;
  return { col: (key % stride) - 1, row: Math.floor(key / stride) - 1 };
}

interface RayHit {
  readonly distance: number;
  /** The wall cell that stopped the ray, if one did before `maxDist`. */
  readonly wall: { readonly key: WallKey; readonly normal: Point } | undefined;
}

function hitAt(
  map: TileMap,
  distance: number,
  col: number,
  row: number,
  normal: Point = { x: 0, y: 0 },
): RayHit | undefined {
  if (!isSolid(map, col, row)) return undefined;
  return {
    distance,
    wall: { key: (row + 1) * (map.cols + 2) + col + 1, normal },
  };
}

function castRay(
  map: TileMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxDist: number,
): RayHit {
  const cell = map.cell;
  let col = Math.floor(x / cell);
  let row = Math.floor(y / cell);
  const inside = hitAt(map, 0, col, row);
  if (inside !== undefined) return inside;

  const stepCol = Math.sign(dx);
  const stepRow = Math.sign(dy);
  const deltaX = dx === 0 ? Infinity : Math.abs(cell / dx);
  const deltaY = dy === 0 ? Infinity : Math.abs(cell / dy);
  let maxX =
    dx > 0
      ? ((col + 1) * cell - x) / dx
      : dx < 0
        ? (col * cell - x) / dx
        : Infinity;
  let maxY =
    dy > 0
      ? ((row + 1) * cell - y) / dy
      : dy < 0
        ? (row * cell - y) / dy
        : Infinity;

  for (;;) {
    const distance = Math.min(maxX, maxY);
    if (distance >= maxDist) return { distance: maxDist, wall: undefined };

    if (Math.abs(maxX - maxY) <= 1e-9) {
      const corner =
        hitAt(map, distance, col + stepCol, row, { x: -stepCol, y: 0 }) ??
        hitAt(map, distance, col, row + stepRow, { x: 0, y: -stepRow }) ??
        hitAt(map, distance, col + stepCol, row + stepRow, {
          x: -stepCol,
          y: 0,
        });
      if (corner !== undefined) return corner;
      col += stepCol;
      row += stepRow;
      maxX += deltaX;
      maxY += deltaY;
    } else if (maxX < maxY) {
      col += stepCol;
      const hit = hitAt(map, maxX, col, row, { x: -stepCol, y: 0 });
      if (hit !== undefined) return hit;
      maxX += deltaX;
    } else {
      row += stepRow;
      const hit = hitAt(map, maxY, col, row, { x: 0, y: -stepRow });
      if (hit !== undefined) return hit;
      maxY += deltaY;
    }
  }
}

export function hasLineOfSight(map: TileMap, from: Point, to: Point): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return true;

  const hit = castRay(
    map,
    from.x,
    from.y,
    dx / distance,
    dy / distance,
    distance,
  );
  return hit.distance >= distance;
}

export function directionalVision(
  origin: Point,
  direction: number,
  vision: VisionConfig,
  range = Infinity,
): [VisionSource, LightSource] {
  return [
    {
      x: origin.x,
      y: origin.y,
      range,
      shape: {
        kind: "cone",
        direction,
        angle: vision.coneAngle,
      },
    },
    surroundingsVision(origin, vision, range),
  ];
}

/** The small circle around the viewer that is both seen and lit, behind them included. */
function surroundingsVision(
  viewer: Point,
  vision: VisionConfig,
  range: number,
): LightSource {
  return {
    x: viewer.x,
    y: viewer.y,
    range: Math.min(range, vision.surroundingsRadius),
  };
}

export function visionOrigins(game: Session, viewer: Viewer): VisionSource[] {
  return [
    ...directionalVision(viewer, viewer.aim, game.config.vision),
    ...[...game.entities.values()].filter(
      (entity) => entity.ownerId === viewer.id && entity.grantsVision,
    ),
  ];
}

export function lightSources(game: Session, viewer: Viewer): LightSource[] {
  const [cone, surroundings] = directionalVision(
    viewer,
    viewer.aim,
    game.config.vision,
  );
  const lights: LightSource[] = [
    { ...cone, range: game.config.light.range },
    surroundings,
  ];

  game.entities.forEach((entity) => {
    const emission = game.entityTypes.get(entity.kind)?.light(entity);
    if (emission === undefined || emission === null) return;
    lights.push({ ...emission, x: entity.x, y: entity.y });
  });

  return lights;
}

export function isVisible(
  map: TileMap,
  sources: readonly VisionSource[],
  lights: readonly LightSource[],
  point: Point,
): boolean {
  return (
    sources.some((source) => canSeeFrom(map, source, point)) &&
    lights.some((light) => canSeeFrom(map, light, point))
  );
}

function cornerRayOffsets(
  map: TileMap,
  origin: Point,
  start: number,
  sweep: number,
  limit: number,
): number[] {
  const offsets: number[] = [];
  const minCol = Math.max(0, Math.floor((origin.x - limit) / map.cell));
  const maxCol = Math.min(map.cols, Math.ceil((origin.x + limit) / map.cell));
  const minRow = Math.max(0, Math.floor((origin.y - limit) / map.cell));
  const maxRow = Math.min(map.rows, Math.ceil((origin.y + limit) / map.cell));
  const turn = Math.PI * 2;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const dx = col * map.cell - origin.x;
      const dy = row * map.cell - origin.y;
      if (dx === 0 && dy === 0) continue;

      const topLeft = isSolid(map, col - 1, row - 1);
      const topRight = isSolid(map, col, row - 1);
      const bottomLeft = isSolid(map, col - 1, row);
      const bottomRight = isSolid(map, col, row);
      const solidCount =
        Number(topLeft) +
        Number(topRight) +
        Number(bottomLeft) +
        Number(bottomRight);

      if (solidCount === 0 || solidCount === 4) continue;

      const direction = Math.atan2(dy, dx);
      for (const adjustment of [-1e-7, 0, 1e-7]) {
        const offset =
          (((direction + adjustment - start) % turn) + turn) % turn;
        if (offset <= sweep) offsets.push(offset);
      }
    }
  }

  return offsets;
}

interface WallFace {
  readonly from: Point;
  readonly to: Point;
  readonly normal: Point;
}

export interface VisibilityPolygon {
  readonly points: readonly Point[];
  /** The wall cells whose faces the polygon's rays end on. */
  readonly walls: ReadonlyMap<WallKey, readonly WallFace[]>;
}

const FACE_EPSILON = 1e-7;

function addWallFace(
  walls: Map<WallKey, WallFace[]>,
  key: WallKey,
  face: WallFace,
): void {
  const faces = walls.get(key) ?? [];
  let merged = face;

  for (let i = faces.length - 1; i >= 0; i--) {
    const other = faces[i];
    if (other === undefined) continue;
    if (
      other.normal.x !== merged.normal.x ||
      other.normal.y !== merged.normal.y ||
      other.to.x < merged.from.x - FACE_EPSILON ||
      other.to.y < merged.from.y - FACE_EPSILON ||
      merged.to.x < other.from.x - FACE_EPSILON ||
      merged.to.y < other.from.y - FACE_EPSILON
    )
      continue;

    merged = {
      from: {
        x: Math.min(merged.from.x, other.from.x),
        y: Math.min(merged.from.y, other.from.y),
      },
      to: {
        x: Math.max(merged.to.x, other.to.x),
        y: Math.max(merged.to.y, other.to.y),
      },
      normal: merged.normal,
    };
    faces.splice(i, 1);
  }

  faces.push(merged);
  walls.set(key, faces);
}

function wallFaceBetween(
  map: TileMap,
  origin: Point,
  wall: NonNullable<RayHit["wall"]>,
  firstAngle: number,
  lastAngle: number,
  limit: number,
): WallFace | undefined {
  const { normal } = wall;
  if (normal.x === 0 && normal.y === 0) return undefined;

  const { col, row } = wallCell(map, wall.key);
  const vertical = normal.x !== 0;
  const fixed = vertical
    ? (col + Number(normal.x > 0)) * map.cell
    : (row + Number(normal.y > 0)) * map.cell;
  const distance = fixed - (vertical ? origin.x : origin.y);
  if (distance === 0 || Math.abs(distance) >= limit) return undefined;

  const project = (angle: number): number =>
    vertical
      ? origin.y + (distance * Math.sin(angle)) / Math.cos(angle)
      : origin.x + (distance * Math.cos(angle)) / Math.sin(angle);
  const first = project(firstAngle);
  const last = project(lastAngle);
  const center = vertical ? origin.y : origin.x;
  const reach = Math.sqrt(limit * limit - distance * distance);
  const cellStart = (vertical ? row : col) * map.cell;
  const from = Math.max(cellStart, center - reach, Math.min(first, last));
  const to = Math.min(
    cellStart + map.cell,
    center + reach,
    Math.max(first, last),
  );
  if (to - from <= FACE_EPSILON) return undefined;

  return {
    from: vertical ? { x: fixed, y: from } : { x: from, y: fixed },
    to: vertical ? { x: fixed, y: to } : { x: to, y: fixed },
    normal,
  };
}

function traceWallFaces(
  map: TileMap,
  origin: Point,
  angles: readonly number[],
  closed: boolean,
  limit: number,
): Map<WallKey, WallFace[]> {
  const walls = new Map<WallKey, WallFace[]>();

  for (const [index, first] of angles.entries()) {
    const last =
      angles[index + 1] ??
      (closed
        ? first + Math.PI * 2 - (first - (angles[0] ?? first))
        : undefined);
    if (last === undefined || last <= first) continue;

    const middle = (first + last) / 2;
    const { wall } = castRay(
      map,
      origin.x,
      origin.y,
      Math.cos(middle),
      Math.sin(middle),
      limit + Math.SQRT2 * map.cell,
    );
    if (wall === undefined) continue;

    const face = wallFaceBetween(map, origin, wall, first, last, limit);
    if (face !== undefined) addWallFace(walls, wall.key, face);
  }

  return walls;
}

function intersectWallFaces(
  seen: WallFace,
  lit: WallFace,
): WallFace | undefined {
  if (seen.normal.x !== lit.normal.x || seen.normal.y !== lit.normal.y)
    return undefined;

  const from = {
    x: Math.max(seen.from.x, lit.from.x),
    y: Math.max(seen.from.y, lit.from.y),
  };
  const to = {
    x: Math.min(seen.to.x, lit.to.x),
    y: Math.min(seen.to.y, lit.to.y),
  };
  const length = seen.normal.x === 0 ? to.x - from.x : to.y - from.y;
  if (length <= FACE_EPSILON) return undefined;

  return { from, to, normal: seen.normal };
}

/**
 * Wall cells to draw as lit: a face some vision polygon reaches that some light polygon also
 * reaches. Walls stop rays, so they are never inside the polygons themselves.
 */
export function litWalls(
  seen: readonly VisibilityPolygon[],
  lit: readonly VisibilityPolygon[],
): Map<WallKey, WallFace[]> {
  const result = new Map<WallKey, WallFace[]>();
  for (const polygon of seen) {
    for (const [wall, faces] of polygon.walls) {
      for (const light of lit) {
        for (const illuminated of light.walls.get(wall) ?? []) {
          for (const face of faces) {
            const overlap = intersectWallFaces(face, illuminated);
            if (overlap !== undefined) addWallFace(result, wall, overlap);
          }
        }
      }
    }
  }
  return result;
}

export function visibilityPolygon(
  map: TileMap,
  origin: VisionSource,
  rayCount: number,
  maxDist: number = Math.hypot(map.cols * map.cell, map.rows * map.cell),
): VisibilityPolygon {
  const cone = origin.shape?.kind === "cone" ? origin.shape : undefined;
  const points: Point[] =
    cone === undefined ? [] : [{ x: origin.x, y: origin.y }];
  const sweep = cone?.angle ?? Math.PI * 2;
  const start = cone === undefined ? 0 : cone.direction - sweep / 2;
  const count =
    cone === undefined
      ? rayCount
      : Math.max(2, Math.ceil((rayCount * sweep) / (Math.PI * 2)) + 1);
  const limit = Math.min(maxDist, origin.range ?? Infinity);

  const offsets = new Set(cornerRayOffsets(map, origin, start, sweep, limit));
  for (let i = 0; i < count; i++) {
    offsets.add((i / (cone === undefined ? count : count - 1)) * sweep);
  }

  const angles = [...offsets]
    .sort((a, b) => a - b)
    .map((offset) => start + offset);
  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const { distance } = castRay(map, origin.x, origin.y, dx, dy, limit);
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }

  return {
    points,
    walls: traceWallFaces(map, origin, angles, cone === undefined, limit),
  };
}
