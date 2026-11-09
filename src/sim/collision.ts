import type { Point, TileMap } from "./map.js";
import { isAreaFree, isSolid } from "./map.js";

export interface Body extends Point {
  vx: number;
  vy: number;
}

type Axis = "x" | "y";

const VELOCITY = { x: "vx", y: "vy" } as const;
const EPSILON = 1e-6;
const FREE_POINT_STEP = 4;

function cellRange(min: number, max: number, cell: number): [number, number] {
  return [Math.floor(min / cell + EPSILON), Math.floor(max / cell - EPSILON)];
}

/** Pushes `body` out of any wall it overlaps along `axis`, against its velocity. */
function resolveAxis(
  body: Body,
  half: number,
  map: TileMap,
  bounce: number,
  axis: Axis,
): void {
  const velocityKey = VELOCITY[axis];
  const velocity = body[velocityKey];
  const [minRow, maxRow] = cellRange(body.y - half, body.y + half, map.cell);
  const [minCol, maxCol] = cellRange(body.x - half, body.x + half, map.cell);
  let collisionFace = velocity > 0 ? Infinity : -Infinity;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (!isSolid(map, col, row)) continue;
      const index = axis === "x" ? col : row;
      if (velocity > 0)
        collisionFace = Math.min(collisionFace, index * map.cell - half);
      if (velocity < 0)
        collisionFace = Math.max(collisionFace, (index + 1) * map.cell + half);
    }
  }

  if (Number.isFinite(collisionFace)) {
    body[axis] = collisionFace;
    body[velocityKey] = -velocity * bounce;
  }
}

/** Samples `from`→`to` every FREE_POINT_STEP; `at(t)` gives the point at fraction t. */
function sampleSegment(
  from: Point,
  to: Point,
): { steps: number; at: (t: number) => Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    steps: Math.ceil(Math.hypot(dx, dy) / FREE_POINT_STEP),
    at: (t) => ({ x: from.x + dx * t, y: from.y + dy * t }),
  };
}

/** @public Free point closest to `to` on the segment, scanning back from `to`. */
export function furthestFreePointAlong(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
): Point {
  const { steps, at } = sampleSegment(from, to);

  for (let i = 0; i <= steps; i++) {
    const point = at(steps === 0 ? 0 : 1 - i / steps);
    if (isAreaFree(map, point.x, point.y, half)) return point;
  }

  return from;
}

/** @public Last free point before the first obstruction, walking from `from`. */
export function lastFreePointAlong(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
): Point {
  const { steps, at } = sampleSegment(from, to);

  for (let i = 1; i <= steps; i++) {
    const point = at(i / steps);
    if (!isAreaFree(map, point.x, point.y, half)) return at((i - 1) / steps);
  }

  return { x: to.x, y: to.y };
}

/** @public */
export function nearestFreePoint(
  map: TileMap,
  half: number,
  from: Point,
): Point {
  for (let radius = 0; ; radius += FREE_POINT_STEP) {
    const samples = Math.max(
      1,
      Math.ceil((radius * 2 * Math.PI) / FREE_POINT_STEP),
    );
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const point = {
        x: from.x + Math.cos(angle) * radius,
        y: from.y + Math.sin(angle) * radius,
      };
      if (isAreaFree(map, point.x, point.y, half)) return point;
    }
  }
}

export function moveWithCollision(
  body: Body,
  half: number,
  dt: number,
  map: TileMap,
  bounce: number,
): void {
  body.x += body.vx * dt;
  resolveAxis(body, half, map, bounce, "x");
  body.y += body.vy * dt;
  resolveAxis(body, half, map, bounce, "y");
}
