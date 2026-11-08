import {
  EntityKind,
  INVENTORY_SLOTS,
  PLAYER_ACCELERATION,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SPRINT_MULTIPLIER,
} from "./config.js";
import type { Body } from "./collision.js";
import { moveWithCollision } from "./collision.js";
import type { Point, TileMap, World } from "./map.js";
import { randomFreePosition } from "./map.js";
import type { Inventory } from "./inventory.js";
import { createInventory } from "./inventory.js";

export interface Controls {
  readonly move: Point;
  readonly aim: Point;
  readonly sprint: boolean;
}

export interface Player extends Body {
  readonly id: string;
  readonly kind: typeof EntityKind.PLAYER;
  name: string;
  /** Network target position; remote players are smoothed towards it. */
  tx: number;
  ty: number;
  aim: number;
  radius: number;
  lastSeen: number;
  inventory: Inventory;
}

export interface PlayerState {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly aim: number;
}

export function createPlayer(id: string, name: string, world: World): Player {
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

export function updatePlayer(
  player: Player,
  controls: Controls,
  dt: number,
  map: TileMap,
): void {
  const speed = controls.sprint
    ? PLAYER_SPEED * SPRINT_MULTIPLIER
    : PLAYER_SPEED;
  const targetX = controls.move.x * speed;
  const targetY = controls.move.y * speed;
  const dx = targetX - player.vx;
  const dy = targetY - player.vy;
  const distance = Math.hypot(dx, dy);
  const change = Math.min(distance, PLAYER_ACCELERATION * dt);

  if (distance > 0) {
    player.vx += (dx / distance) * change;
    player.vy += (dy / distance) * change;
  }

  player.aim = Math.atan2(controls.aim.y - player.y, controls.aim.x - player.x);
  moveWithCollision(player, player.radius, dt, map);
}

export function smoothPlayer(player: Player, dt: number): void {
  const amount = 1 - Math.exp(-12 * dt);
  player.x += (player.tx - player.x) * amount;
  player.y += (player.ty - player.y) * amount;
}

export function playerState(player: Player): PlayerState {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    aim: player.aim,
  };
}
