import { VISION_RAYS } from "./config.js";
import type { Point, TileMap } from "./map.js";
import { isSolid } from "./map.js";
import type { Session } from "./session.js";

interface Viewer extends Point {
  readonly id: string;
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

export function visionOrigins(game: Session, viewer: Viewer): Point[] {
  return [
    viewer,
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
    hasLineOfSight(game.world.map, origin, point),
  );
}

export function visibilityPolygon(
  map: TileMap,
  origin: Point,
  rayCount: number = VISION_RAYS,
  maxDist: number = Math.hypot(map.cols * map.cell, map.rows * map.cell),
): Point[] {
  const points: Point[] = [];

  for (let i = 0; i < rayCount; i++) {
    const angle = (i / rayCount) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const distance = castRay(map, origin.x, origin.y, dx, dy, maxDist);
    points.push({ x: origin.x + dx * distance, y: origin.y + dy * distance });
  }

  return points;
}
