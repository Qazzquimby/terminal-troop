import { moveWithCollision } from "./collision.js";
import type { Entity } from "./entity.js";
import type { Facing, Interpolated, Tracked } from "./interpolation.js";
import { easeToTarget, lerpAngle } from "./interpolation.js";
import type { Point, TileMap, World, WorldConfig } from "./map.js";
import { randomFreePosition } from "./map.js";
import type { HeldSlot, Inventory } from "./inventory.js";
import { selectSlot } from "./inventory.js";
import type { ItemUse } from "./use.js";
import type { Stamina, StaminaConfig } from "./stamina.js";
import { canSprint, createStamina, updateStamina } from "./stamina.js";

const EntityKind = { PLAYER: 0 } as const;

/** Player body and movement tuning. */
interface PlayerConfig {
  readonly radius: number;
  /** Top walking speed, in pixels per second. */
  readonly speed: number;
  /** Change of velocity per second towards the target speed, in pixels per second. */
  readonly acceleration: number;
  /** Top sprinting speed as a multiple of `speed`. */
  readonly sprintMultiplier: number;
  /** Health when at full. */
  readonly maxHealth: number;
  readonly inventorySlots: number;
  /** Longest name, in characters. */
  readonly nameMax: number;
}

/** The tuning a player's creation and step read. */
export interface PlayerRules {
  readonly player: PlayerConfig;
  readonly stamina: StaminaConfig;
  readonly world: WorldConfig;
}
export interface Controls {
  readonly move: Point;
  readonly aim: Point;
  readonly sprint: boolean;
  /** The inventory slot to select this step, or null to keep the current one. */
  readonly select: number | null;
  /** Whether to use the held item this step. */
  readonly use: boolean;
  /** Whether to pick up a nearby ground item this step. */
  readonly pickup: boolean;
}

export interface Player extends Entity, Interpolated, Facing, Tracked {
  readonly id: string;
  readonly kind: typeof EntityKind.PLAYER;
  name: string;
  /** Network target facing; remote players turn towards it along the shortest arc. */
  taim: number;
  /** Empty until the room's items stock the local player's; never sent over the network. */
  inventory: Inventory;
  /** The selected inventory slot, or null for holding nothing; never sent over the network. */
  held: HeldSlot;
  /** Only meaningful for the local player; never sent over the network. */
  stamina: Stamina;
  /** The local player's latest item use; never sent over the network. */
  use: ItemUse | null;
}

export interface PlayerState {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly aim: number;
  readonly health: number;
}

export function createPlayer(
  id: string,
  name: string,
  world: World,
  rules: PlayerRules,
): Player {
  const position = randomFreePosition(world, rules.player.radius);
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
    prevAim: 0,
    taim: 0,
    radius: rules.player.radius,
    inventory: [],
    held: 0,
    stamina: createStamina(rules.stamina),
    use: null,
    health: rules.player.maxHealth,
    maxHealth: rules.player.maxHealth,
  };
}

export function updatePlayer(
  player: Player,
  controls: Controls,
  dt: number,
  map: TileMap,
  rules: PlayerRules,
): void {
  const { player: config } = rules;
  if (controls.select !== null)
    player.held = selectSlot(player.inventory, controls.select);
  const moving = controls.move.x !== 0 || controls.move.y !== 0;
  const sprinting = controls.sprint && moving && canSprint(player.stamina);
  player.stamina = updateStamina(player.stamina, sprinting, dt, rules.stamina);

  const speed = sprinting
    ? config.speed * config.sprintMultiplier
    : config.speed;
  const targetX = controls.move.x * speed;
  const targetY = controls.move.y * speed;
  const dx = targetX - player.vx;
  const dy = targetY - player.vy;
  const distance = Math.hypot(dx, dy);
  const change = Math.min(distance, config.acceleration * dt);

  if (distance > 0) {
    player.vx += (dx / distance) * change;
    player.vy += (dy / distance) * change;
  }

  player.aim = aimAt(player, controls.aim);
  moveWithCollision(player, player.radius, dt, map, rules.world.wallBounce);
}

/** The facing, in radians, from `from` towards `target`. */
export function aimAt(from: Point, target: Point): number {
  return Math.atan2(target.y - from.y, target.x - from.x);
}

/** Eases a remote player towards its network target; `rate` is per second. */
export function smoothPlayer(player: Player, dt: number, rate: number): void {
  const amount = 1 - Math.exp(-rate * dt);
  easeToTarget(player, amount);
  player.aim = lerpAngle(player.aim, player.taim, amount);
}

export function playerState(player: Player): PlayerState {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    aim: player.aim,
    health: player.health,
  };
}
