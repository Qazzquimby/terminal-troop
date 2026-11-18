import { heldItemOf } from "./inventories.js";
import type { Point, TileMap } from "./map.js";
import { isSolid } from "./map.js";
import type { Session } from "./session.js";
import {
  edgeAngles,
  inShadow,
  noShadows,
  occludedDistance,
  shadowing,
} from "./shadow.js";
import type { Occluder, ShadowsOf } from "./shadow.js";
import { footprintPoints } from "./shape.js";
import type { Footprint } from "./shape.js";

export { footprintPoints };
export type { Footprint };

/** How a player sees. */
export interface VisionConfig {
  /** Width of the view cone, in radians. */
  readonly coneAngle: number;
  /** Rays cast around a full circle when tracing what a source reaches. */
  readonly rays: number;
  /** Radius of the circle around the player that is always seen and lit, behind them too. */
  readonly surroundingsRadius: number;
  /**
   * How far down the view cone a player looks at something, light or no light, as what is held
   * while looked at asks. What it sees drawn is down to light, not this.
   */
  readonly lookRange: number;
  /**
   * How far apart, in pixels, the points are that a body's footprint is checked at, so a body
   * shows while any part of it is in sight, not only its centre.
   */
  readonly footprintSpacing: number;
}

/** The light a player carries. */
export interface LightConfig {
  /** How far the light reaches along the view cone, in pixels. */
  readonly range: number;
  /** How bodies shadow lights given off and carried (#384); see shadow.ts. */
  readonly shadows: ShadowConfig;
}

/** How bodies shadow the lights given off and carried round them. */
interface ShadowConfig {
  /** Whether bodies cast shadows at all, to see and to every rule that asks of light. */
  readonly cast: boolean;
  /**
   * Whether what lies in a shadow is dark to the rules that ask of light, such as a stalker
   * hunting only bodies out of the light; false keeps shadows only to look at.
   */
  readonly gameplay: boolean;
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
  /** Where it shines from, relative to the centre of what gives it off; that centre when left out. */
  readonly from?: Point;
  /**
   * The colour it tints the ground it lights, a CSS colour with its own alpha, such as a flare's
   * red; the warm yellow of a flashlight when left out. Only how it looks: lit is lit.
   */
  readonly tint?: string;
}

export interface LightSource extends Point, LightEmission {
  /** How far it reaches into deepdark, in pixels; its whole range when left out. */
  readonly deepRange?: number;
}

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
 * Whether `light` lights `point`: it reaches it along a clear line, and none of `occluders` but
 * `ignore`, by id, shadows it from there.
 */
export function litFrom(
  map: TileMap,
  light: VisionSource,
  point: Point,
  occluders: readonly Occluder[] = [],
  ignore: string | null = null,
): boolean {
  return (
    canSeeFrom(map, light, point) &&
    (occluders.length === 0 || !inShadow(occluders, light, point, ignore))
  );
}

/**
 * Identifies a wall cell. Rays can stop on the solid ring just outside the map, so cells are
 * numbered row-major over the map padded by one cell on every side.
 */
type WallKey = number;

/** The key of the wall cell at `col`, `row`, which may be just outside the map. */
export function wallKey(map: TileMap, col: number, row: number): WallKey {
  return (row + 1) * (map.cols + 2) + col + 1;
}

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
    wall: { key: wallKey(map, col, row), normal },
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

/**
 * How far a ray from `from` along the unit vector `direction` goes before a wall stops it, at
 * most `maxDist` pixels.
 */
export function distanceToWall(
  map: TileMap,
  from: Point,
  direction: Point,
  maxDist: number,
): number {
  return castRay(map, from.x, from.y, direction.x, direction.y, maxDist)
    .distance;
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

/**
 * `emission` given off by something standing at `at`, reaching `deep` of its range into
 * deepdark.
 */
function placed(at: Point, emission: LightEmission, deep: number): LightSource {
  const { from, ...light } = emission;
  return {
    ...light,
    x: at.x + (from?.x ?? 0),
    y: at.y + (from?.y ?? 0),
    deepRange: light.range * deep,
  };
}

/**
 * The lights entities and held items give off, such as a cruiser's headlights or a flashlight
 * switched on, apart from any viewer's own sight.
 */
export function emittedLights(game: Session): LightSource[] {
  const lights: LightSource[] = [];
  const deep = game.config.deepdark.light;
  game.entities.forEach((entity) => {
    const emissions = game.entityTypes.get(entity.kind)?.light(entity) ?? [];
    for (const emission of emissions)
      lights.push(placed(entity, emission, deep));
  });
  game.players.forEach((player) => {
    const item = heldItemOf(game, player);
    if (item === null) return;
    const emission = game.items.get(item.id)?.light?.(game, player);
    if (emission === undefined || emission === null) return;
    lights.push(placed(player, emission, deep));
  });
  return lights;
}

/**
 * The lights `viewer` sees by: its own sight, down its cone and round it, reaching into deepdark
 * only the deepdark config's `sight` of its range, and every light given off.
 */
export function lightSources(game: Session, viewer: Viewer): LightSource[] {
  return [...sightLights(game, viewer), ...emittedLights(game)];
}

/**
 * The lights of `viewer`'s own sight alone, down its cone and round it, reaching into deepdark
 * only the deepdark config's `sight` of its range.
 */
export function sightLights(game: Session, viewer: Viewer): LightSource[] {
  const [cone, surroundings] = directionalVision(
    viewer,
    viewer.aim,
    game.config.vision,
  );
  const { sight } = game.config.deepdark;
  const { range } = game.config.light;
  return [
    { ...cone, range, deepRange: range * sight },
    { ...surroundings, deepRange: surroundings.range * sight },
  ];
}

/** What bears on whether a point is lit, past the lights themselves; none of it by default. */
interface Lighting {
  /** Whether the place's own light lights a point, such as sunlight out of doors. */
  readonly ambient?: (point: Point) => boolean;
  /** Whether darkness something gives off reaches a point, which no light lights. */
  readonly dark?: (point: Point) => boolean;
  /** Whether a point is deepdark, which no place's own light lights. */
  readonly deep?: (point: Point) => boolean;
  /** The bodies that can shadow each light, as `shadowsOf` finds them. */
  readonly shadows?: ShadowsOf;
}

const never = (): boolean => false;

/**
 * Whether `point` is both seen from some source and lit: by some light that reaches it unshadowed
 * by `lighting`'s shadows, or where its `ambient` says the place's own light does; and not where
 * its `dark` says darkness given off reaches it. Where its `deep` says it is deepdark, no place's
 * own light lights it, and each light reaches it only out to its `deepRange`.
 */
export function isVisible(
  map: TileMap,
  sources: readonly VisionSource[],
  lights: readonly LightSource[],
  point: Point,
  lighting: Lighting = {},
): boolean {
  const { ambient = never, dark = never, deep = never } = lighting;
  const { shadows = noShadows } = lighting;
  if (dark(point) || !sources.some((source) => canSeeFrom(map, source, point)))
    return false;
  const deepdark = deep(point);
  if (!deepdark && ambient(point)) return true;
  return lights.some((light) =>
    litFrom(
      map,
      deepdark ? { ...light, range: light.deepRange ?? light.range } : light,
      point,
      shadows(light),
    ),
  );
}

/**
 * Whether any part of `body` is both seen and lit, as `isVisible` judges a point, checked at
 * points about `spacing` apart over its footprint. A big body whose centre has gone out of sight
 * still shows while its edge is in it.
 */
export function isBodyVisible(
  map: TileMap,
  sources: readonly VisionSource[],
  lights: readonly LightSource[],
  body: Footprint,
  spacing: number,
  lighting: Lighting = {},
): boolean {
  return footprintPoints(body, spacing).some((point) =>
    isVisible(map, sources, lights, point, lighting),
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
  // A viewer below the map stands in a pocket, whose corners lie past its last row.
  const lastRow = origin.y > map.rows * map.cell ? Infinity : map.rows;
  const maxRow = Math.min(lastRow, Math.ceil((origin.y + limit) / map.cell));
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

export interface WallFace {
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
  occluders: readonly Occluder[],
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
    const direction = { x: Math.cos(middle), y: Math.sin(middle) };
    const { wall, distance } = castRay(
      map,
      origin.x,
      origin.y,
      direction.x,
      direction.y,
      limit + Math.SQRT2 * map.cell,
    );
    if (wall === undefined) continue;
    // A body between the light and the wall shadows its face.
    if (occludedDistance(occluders, origin, direction, distance) < distance)
      continue;

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

/**
 * What `origin` reaches, traced by `rayCount` rays round it or down its cone and one at each wall
 * corner: the polygon its rays end on, and the wall faces they end on. Each of `occluders`, the
 * bodies casting shadows in a light, stops a ray at its far side, so the body is reached and
 * what lies behind it is not.
 */
export function visibilityPolygon(
  map: TileMap,
  origin: VisionSource,
  rayCount: number,
  maxDist: number = Math.hypot(map.cols * map.cell, map.rows * map.cell),
  occluders: readonly Occluder[] = [],
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
  const blocking =
    occluders.length === 0 ? [] : shadowing(occluders, origin, limit);
  const turn = Math.PI * 2;
  for (const angle of edgeAngles(blocking, origin)) {
    const offset = (((angle - start) % turn) + turn) % turn;
    if (offset <= sweep) offsets.add(offset);
  }

  const angles = [...offsets]
    .sort((a, b) => a - b)
    .map((offset) => start + offset);
  for (const angle of angles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const wall = castRay(map, origin.x, origin.y, dx, dy, limit).distance;
    const distance =
      blocking.length === 0
        ? wall
        : occludedDistance(blocking, origin, { x: dx, y: dy }, wall);
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }

  return {
    points,
    walls: traceWallFaces(
      map,
      origin,
      angles,
      cone === undefined,
      limit,
      blocking,
    ),
  };
}
