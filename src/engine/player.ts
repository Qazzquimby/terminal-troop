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
import type { Interpolated } from "./interpolation.js";
import type { Point, TileMap, World } from "./map.js";
import { randomFreePosition } from "./map.js";
import type { Inventory } from "./inventory.js";
import { createInventory } from "./inventory.js";
import type { Stamina } from "./stamina.js";
import { canSprint, createStamina, updateStamina } from "./stamina.js";

export interface Controls {
  readonly move: Point;
  readonly aim: Point;
  readonly sprint: boolean;
}

export interface Player extends Body, Interpolated {
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
  /** Only meaningful for the local player; never sent over the network. */
  stamina: Stamina;
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
    prevX: position.x,
    prevY: position.y,
    tx: position.x,
    ty: position.y,
    vx: 0,
    vy: 0,
    aim: 0,
    radius: PLAYER_RADIUS,
    lastSeen: performance.now(),
    inventory: createInventory(INVENTORY_SLOTS),
    stamina: createStamina(),
  };
}

export function updatePlayer(
  player: Player,
  controls: Controls,
  dt: number,
  map: TileMap,
): void {
  const moving = controls.move.x !== 0 || controls.move.y !== 0;
  const sprinting = controls.sprint && moving && canSprint(player.stamina);
  player.stamina = updateStamina(player.stamina, sprinting, dt);

  const speed = sprinting ? PLAYER_SPEED * SPRINT_MULTIPLIER : PLAYER_SPEED;
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
