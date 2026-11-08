import {
  EntityKind,
  INVENTORY_SLOTS,
  PLAYER_ACCELERATION,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from "./config.js";
import { moveWithCollision } from "./collision.js";
import { randomFreePosition } from "./map.js";
import { createInventory } from "./inventory.js";

export function createPlayer(id, name, world) {
  const position = randomFreePosition(world, PLAYER_RADIUS);
  return {
    id,
    name,
    kind: EntityKind.PLAYER,
    ...position,
    tx: position.x,
    ty: position.y,
    vx: 0,
    vy: 0,
    aim: 0,
    radius: PLAYER_RADIUS,
    lastSeen: performance.now(),
    inventory: createInventory(INVENTORY_SLOTS),
  };
}

export function updatePlayer(player, controls, dt, map) {
  const targetX = controls.move.x * PLAYER_SPEED;
  const targetY = controls.move.y * PLAYER_SPEED;
  const dx = targetX - player.vx;
  const dy = targetY - player.vy;
  const distance = Math.hypot(dx, dy);
  const change = Math.min(distance, PLAYER_ACCELERATION * dt);

  if (distance > 0) {
    player.vx += dx / distance * change;
    player.vy += dy / distance * change;
  }

  player.aim = Math.atan2(
    controls.aim.y - player.y,
    controls.aim.x - player.x,
  );
  moveWithCollision(player, player.radius, dt, map);
}

export function smoothPlayer(player, dt) {
  const amount = 1 - Math.exp(-12 * dt);
  player.x += (player.tx - player.x) * amount;
  player.y += (player.ty - player.y) * amount;
}

export function playerState(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    aim: player.aim,
  };
}
