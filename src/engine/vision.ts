import { VISION_RAYS } from "./config.js";
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
    if (maxX < maxY) {
      if (maxX >= maxDist) return maxDist;
      col += stepCol;
      if (isSolid(map, col, row)) return maxX;
      maxX += deltaX;
    } else {
      if (maxY >= maxDist) return maxDist;
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

export function visionOrigins(game: Session, viewer: Viewer): VisionSource[] {
  return [
    {
      x: viewer.x,
      y: viewer.y,
      shape: {
        kind: "cone",
        direction: viewer.aim,
        angle: Math.PI / 2,
      },
    },
    ...[...game.entities.values()].filter(
      (entity) => entity.ownerId === viewer.id && entity.grantsVision,
    ),
  ];
}

export function canSeePoint(
  game: Session,
  viewer: Viewer,
  point: Point,
): boolean {
  return visionOrigins(game, viewer).some((origin) =>
    canSeeFrom(game.world.map, origin, point),
  );
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

  for (let i = 0; i < count; i++) {
    const angle = start + (i / (cone === undefined ? count : count - 1)) * sweep;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = castRay(map, origin.x, origin.y, dx, dy, limit);
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }

  return points;
}
