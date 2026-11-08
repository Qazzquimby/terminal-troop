import {
  PLAYER_LIGHT_RANGE,
  PLAYER_VISION_ANGLE,
  VISION_RAYS,
} from "./config.js";
import type { Point, TileMap } from "./map.js";
import { isSolid } from "./map.js";
import type { Session } from "./session.js";

export type VisionShape =
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

function castRay(
  map: TileMap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxDist: number,
): number {
  const cell = map.cell;
  let col = Math.floor(x / cell);
  let row = Math.floor(y / cell);
  if (isSolid(map, col, row)) return 0;

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
    if (distance >= maxDist) return maxDist;

    if (Math.abs(maxX - maxY) <= 1e-9) {
      if (
        isSolid(map, col + stepCol, row) ||
        isSolid(map, col, row + stepRow) ||
        isSolid(map, col + stepCol, row + stepRow)
      ) {
        return distance;
      }
      col += stepCol;
      row += stepRow;
      maxX += deltaX;
      maxY += deltaY;
    } else if (maxX < maxY) {
      col += stepCol;
      if (isSolid(map, col, row)) return maxX;
      maxX += deltaX;
    } else {
      row += stepRow;
      if (isSolid(map, col, row)) return maxY;
      maxY += deltaY;
    }
  }
}

export function hasLineOfSight(map: TileMap, from: Point, to: Point): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return true;

  return (
    castRay(map, from.x, from.y, dx / distance, dy / distance, distance) >=
    distance
  );
}

function playerVision(viewer: Viewer): VisionSource {
  return {
    x: viewer.x,
    y: viewer.y,
    shape: {
      kind: "cone",
      direction: viewer.aim,
      angle: PLAYER_VISION_ANGLE,
    },
  };
}

export function visionOrigins(game: Session, viewer: Viewer): VisionSource[] {
  return [
    playerVision(viewer),
    ...[...game.entities.values()].filter(
      (entity) => entity.ownerId === viewer.id && entity.grantsVision,
    ),
  ];
}

export function lightSources(game: Session, viewer: Viewer): LightSource[] {
  const lights: LightSource[] = [
    { ...playerVision(viewer), range: PLAYER_LIGHT_RANGE },
  ];

  game.entities.forEach((entity) => {
    const emission = game.entityTypes.get(entity.kind)?.light?.(entity);
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

export function canSeePoint(
  game: Session,
  viewer: Viewer,
  point: Point,
): boolean {
  return isVisible(
    game.world.map,
    visionOrigins(game, viewer),
    lightSources(game, viewer),
    point,
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
  const minCol = Math.max(0, Math.ceil((origin.x - limit) / map.cell));
  const maxCol = Math.min(map.cols, Math.floor((origin.x + limit) / map.cell));
  const minRow = Math.max(0, Math.ceil((origin.y - limit) / map.cell));
  const maxRow = Math.min(map.rows, Math.floor((origin.y + limit) / map.cell));
  const turn = Math.PI * 2;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const dx = col * map.cell - origin.x;
      const dy = row * map.cell - origin.y;
      const distance = Math.hypot(dx, dy);
      if (distance === 0 || distance > limit) continue;

      const topLeft = isSolid(map, col - 1, row - 1);
      const topRight = isSolid(map, col, row - 1);
      const bottomLeft = isSolid(map, col - 1, row);
      const bottomRight = isSolid(map, col, row);
      const solidCount =
        Number(topLeft) + Number(topRight) +
        Number(bottomLeft) + Number(bottomRight);

      if (solidCount === 0 || solidCount === 4) continue;
      if (solidCount === 2 && topLeft !== bottomRight) continue;

      const direction = Math.atan2(dy, dx);
      for (const adjustment of [-1e-7, 0, 1e-7]) {
        const offset = ((direction + adjustment - start) % turn + turn) % turn;
        if (offset <= sweep) offsets.push(offset);
      }
    }
  }

  return offsets;
}

export function visibilityPolygon(
  map: TileMap,
  origin: VisionSource,
  rayCount: number = VISION_RAYS,
  maxDist: number = Math.hypot(map.cols * map.cell, map.rows * map.cell),
): Point[] {
  const cone = origin.shape?.kind === "cone" ? origin.shape : undefined;
  const points: Point[] = cone === undefined ? [] : [{ x: origin.x, y: origin.y }];
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

  for (const offset of [...offsets].sort((a, b) => a - b)) {
    const angle = start + offset;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = castRay(map, origin.x, origin.y, dx, dy, limit);
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }

  return points;
}
