import { EntityKind, WALL_BOUNCE } from "./config.js";
import { isAreaFree, isSolid } from "./map.js";

const EPSILON = 1e-6;
const FREE_POINT_STEP = 4;

export function* bodies(game) {
  yield* game.entities.values();
  yield* game.players.values();
}


function cellRange(min, max, cell) {
  return [
    Math.floor(min / cell + EPSILON),
    Math.floor(max / cell - EPSILON),
  ];
}

function resolveX(player, half, map, bounce) {
  const [minRow, maxRow] = cellRange(player.y - half, player.y + half, map.cell);
  const [minCol, maxCol] = cellRange(player.x - half, player.x + half, map.cell);
  let collisionFace = player.vx > 0 ? Infinity : -Infinity;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (!isSolid(map, col, row)) continue;
      if (player.vx > 0) collisionFace = Math.min(collisionFace, col * map.cell - half);
      if (player.vx < 0) collisionFace = Math.max(collisionFace, (col + 1) * map.cell + half);
    }
  }

  if (collisionFace !== Infinity && collisionFace !== -Infinity) {
    player.x = collisionFace;
    player.vx = -player.vx * bounce;
  }
}

function resolveY(player, half, map, bounce) {
  const [minRow, maxRow] = cellRange(player.y - half, player.y + half, map.cell);
  const [minCol, maxCol] = cellRange(player.x - half, player.x + half, map.cell);
  let collisionFace = player.vy > 0 ? Infinity : -Infinity;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      if (!isSolid(map, col, row)) continue;
      if (player.vy > 0) collisionFace = Math.min(collisionFace, row * map.cell - half);
      if (player.vy < 0) collisionFace = Math.max(collisionFace, (row + 1) * map.cell + half);
    }
  }

  if (collisionFace !== Infinity && collisionFace !== -Infinity) {
    player.y = collisionFace;
    player.vy = -player.vy * bounce;
  }
}

export function furthestFreePointAlong(map, half, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.ceil(Math.hypot(dx, dy) / 4);

  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : 1 - i / steps;
    const point = { x: from.x + dx * t, y: from.y + dy * t };
    if (isAreaFree(map, point.x, point.y, half)) return point;
  }

  return from;
}

export function lastFreePointAlong(map, half, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const steps = Math.ceil(distance / 4);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const point = { x: from.x + dx * t, y: from.y + dy * t };
    if (!isAreaFree(map, point.x, point.y, half)) {
      const previousT = (i - 1) / steps;
      return { x: from.x + dx * previousT, y: from.y + dy * previousT };
    }
  }

  return { x: to.x, y: to.y };
}

export function nearestFreePoint(map, half, from) {
  for (let radius = 0; ; radius += FREE_POINT_STEP) {
    const samples = Math.max(1, Math.ceil((radius * 2 * Math.PI) / FREE_POINT_STEP));
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

export function moveWithCollision(player, half, dt, map, bounce = WALL_BOUNCE) {
  player.x += player.vx * dt;
  resolveX(player, half, map, bounce);
  player.y += player.vy * dt;
  resolveY(player, half, map, bounce);
}

function collidesWith(a, b) {
  return !(a.kind === EntityKind.PLAYER && b.kind === EntityKind.PLAYER);
}

export function resolveBodyCollisions(game) {
  const solidBodies = [...bodies(game)].filter((body) => body.solid && body.interactive);

  for (let i = 0; i < solidBodies.length; i++) {
    const a = solidBodies[i];
    for (let j = i + 1; j < solidBodies.length; j++) {
      const b = solidBodies[j];
      if (!collidesWith(a, b)) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const reach = a.radius + b.radius;
      if (distance >= reach) continue;

      const nx = distance === 0 ? 1 : dx / distance;
      const ny = distance === 0 ? 0 : dy / distance;
      const overlap = reach - distance;
      a.x -= nx * overlap / 2;
      a.y -= ny * overlap / 2;
      b.x += nx * overlap / 2;
      b.y += ny * overlap / 2;

      const relativeSpeed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeSpeed < 0) {
        const average = ((a.vx * nx + a.vy * ny) + (b.vx * nx + b.vy * ny)) / 2;
        const aNormal = a.vx * nx + a.vy * ny;
        const bNormal = b.vx * nx + b.vy * ny;
        a.vx += (average - aNormal) * nx;
        a.vy += (average - aNormal) * ny;
        b.vx += (average - bNormal) * nx;
        b.vy += (average - bNormal) * ny;
      }
    }
  }
}
