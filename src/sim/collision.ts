import type { Point, TileMap } from "./map.js";
import { isAreaFree, isSolid } from "./map.js";
import type { Session } from "./session.js";

export interface Body extends Point {
  vx: number;
  vy: number;
}

export interface CollisionBody extends Body {
  readonly radius: number;
}

type Axis = "x" | "y";

const VELOCITY = { x: "vx", y: "vy" } as const;
const EPSILON = 1e-6;
const FREE_POINT_STEP = 4;
const SEPARATION_PASSES = 16;

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

/** Whether a body of half-size `half` fits all along the segment from `from` to `to`. */
export function isSweepFree(
  map: TileMap,
  half: number,
  from: Point,
  to: Point,
): boolean {
  const { steps, at } = sampleSegment(from, to);
  for (let i = 0; i <= steps; i++) {
    const point = at(steps === 0 ? 0 : i / steps);
    if (!isAreaFree(map, point.x, point.y, half)) return false;
  }
  return true;
}

/**
 * @public The free point nearest `from` for a body of half-size `half`, searched out as far as
 * the map reaches; `from` itself when it is not a finite point or the map has no room anywhere.
 */
export function nearestFreePoint(
  map: TileMap,
  half: number,
  from: Point,
): Point {
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return from;
  const reach = Math.hypot(
    Math.abs(from.x) + map.cols * map.cell,
    Math.abs(from.y) + map.rows * map.cell,
  );
  for (let radius = 0; radius <= reach; radius += FREE_POINT_STEP) {
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
  return from;
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

function pushBody(
  body: CollisionBody,
  nx: number,
  ny: number,
  distance: number,
  map: TileMap,
): number {
  const pushed: Body = {
    x: body.x,
    y: body.y,
    vx: nx * distance,
    vy: ny * distance,
  };
  moveWithCollision(pushed, body.radius, 1, map, 0);

  const moved = (pushed.x - body.x) * nx + (pushed.y - body.y) * ny;
  body.x = pushed.x;
  body.y = pushed.y;
  return Math.max(0, moved);
}

function stopTowards(body: Body, nx: number, ny: number): void {
  const speed = body.vx * nx + body.vy * ny;
  if (speed <= 0) return;
  body.vx -= speed * nx;
  body.vy -= speed * ny;
}

function separatePair(
  first: CollisionBody,
  second: CollisionBody,
  map: TileMap,
  movable: ReadonlySet<CollisionBody>,
): boolean {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  const overlap = first.radius + second.radius - distance;
  if (overlap <= EPSILON) return false;

  const moveFirst = movable.has(first);
  const moveSecond = movable.has(second);
  if (!moveFirst && !moveSecond) return false;

  const directions =
    distance === 0
      ? [
          { x: 1, y: 0 },
          { x: -1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: -1 },
        ]
      : [{ x: dx / distance, y: dy / distance }];

  for (const { x: nx, y: ny } of directions) {
    let remaining = overlap + EPSILON;
    let moved = 0;

    if (moveFirst) {
      const shift = pushBody(
        first,
        -nx,
        -ny,
        moveSecond ? remaining / 2 : remaining,
        map,
      );
      remaining = Math.max(0, remaining - shift);
      moved += shift;
    }
    if (moveSecond) {
      const shift = pushBody(second, nx, ny, remaining, map);
      remaining = Math.max(0, remaining - shift);
      moved += shift;
    }
    if (moveFirst && remaining > EPSILON) {
      moved += pushBody(first, -nx, -ny, remaining, map);
    }

    if (moved <= EPSILON) continue;
    if (moveFirst) stopTowards(first, nx, ny);
    if (moveSecond) stopTowards(second, -nx, -ny);
    return true;
  }

  return false;
}

export function separateBodies(
  bodies: readonly CollisionBody[],
  map: TileMap,
  movable: ReadonlySet<CollisionBody> = new Set(bodies),
): void {
  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    let moved = false;
    for (const [index, first] of bodies.entries()) {
      for (const second of bodies.slice(index + 1)) {
        if (separatePair(first, second, map, movable)) moved = true;
      }
    }
    if (!moved) return;
  }
}

/**
 * How far `body` can move from where it stands along the unit vector `direction` before it
 * touches any of `others`; Infinity when none is in the way. One it already touches ahead of it
 * leaves no room at all, and one behind it is no obstacle.
 */
export function distanceToContact(
  body: Pick<CollisionBody, "x" | "y" | "radius">,
  direction: Point,
  others: readonly CollisionBody[],
): number {
  let nearest = Infinity;
  for (const other of others) {
    const dx = other.x - body.x;
    const dy = other.y - body.y;
    const along = dx * direction.x + dy * direction.y;
    if (along <= 0) continue;
    const reach = body.radius + other.radius;
    const across = dx * dx + dy * dy - along * along;
    if (across >= reach * reach) continue;
    nearest = Math.min(
      nearest,
      Math.max(0, along - Math.sqrt(reach * reach - across)),
    );
  }
  return nearest;
}

/** Every body in the session that others collide with, but `body` itself. */
export function solidBodiesBut(
  game: Session,
  body: CollisionBody,
): CollisionBody[] {
  return [
    ...game.players.values(),
    ...[...game.entities.values()].filter((entity) => entity.collides),
  ].filter((other) => other !== body);
}
