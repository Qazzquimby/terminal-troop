import type { CollisionBody } from "./collision.js";
import {
  distanceToContact,
  lastFreePointAlong,
  moveWithCollision,
} from "./collision.js";
import type { Ride } from "./driving.js";
import type { Entity } from "./entity.js";
import type { Facing, Interpolated, Tracked } from "./interpolation.js";
import { easeToTarget, lerpAngle } from "./interpolation.js";
import type { Point, TileMap, WorldConfig } from "./map.js";
import type { HeldSlot, Inventory } from "./inventory.js";
import { createInventory } from "./inventory.js";
import { movement } from "./movement.js";
import type { MovementMode } from "./movement.js";
import type { PlayerData } from "./player-data.js";
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
  /** Top crouching speed as a multiple of `speed`. */
  readonly crouchMultiplier: number;
  /** Health when at full. */
  readonly maxHealth: number;
  /** How many slots a player's inventory has. */
  readonly inventorySlots: number;
  /** Longest name, in characters. */
  readonly nameMax: number;
  /** How long, in seconds, a knocked-back player slides to where the blow sends it. */
  readonly knockbackSeconds: number;
  /** How what a player carries slows it. */
  readonly load: LoadConfig;
}

/** How what a player carries slows it: evenly with each pound, up to a limit. */
interface LoadConfig {
  /** Pounds at which a player is slowest; more slows it no further. */
  readonly full: number;
  /** How much slower a player carrying `full` pounds is, as a fraction of its top speed, 0..1. */
  readonly slowdown: number;
}

/** A player's top speed carrying `pounds`, as a multiple of its top speed carrying nothing. */
export function loadFactor(pounds: number, load: LoadConfig): number {
  if (load.full <= 0) return 1;
  const share = Math.min(1, Math.max(0, pounds / load.full));
  return 1 - load.slowdown * share;
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
  /** Whether to toggle crouching this step. */
  readonly crouch: boolean;
  /** The inventory slot to select this step, or null to keep the current one. */
  readonly select: number | null;
  /** Whether to use the held item this step. */
  readonly use: boolean;
  /** Whether the secondary action was pressed this step. */
  readonly secondary: boolean;
  /**
   * Whether to pick up the nearest item the player touches this step, or failing that work the
   * held item's control.
   */
  readonly interact: boolean;
  /** Whether to drop the held item this step. */
  readonly drop: boolean;
  /** Whether the use control is held down this step: for an item worked while it is, such as a walkie talkie. */
  readonly holdingUse: boolean;
}

/**
 * What walks a player through one step: the way it heads (each axis -1..1), whether it sprints,
 * and whether it pressed crouch, which toggles crouching.
 */
export interface Gait {
  readonly move: Point;
  readonly sprint: boolean;
  readonly crouch: boolean;
}

/** A quick move a player makes on top of walking: a fixed velocity, for a while. */
export interface Dash {
  /** Velocity, in pixels per second. */
  readonly vx: number;
  readonly vy: number;
  /** Seconds it has left. */
  readonly seconds: number;
  /** Where a knockback ends: the player is put here when its time runs out. */
  readonly to?: Point | undefined;
}

export interface Player extends Entity, Interpolated, Facing, Tracked {
  readonly id: string;
  readonly kind: typeof EntityKind.PLAYER;
  name: string;
  /** Network target facing; remote players turn towards it along the shortest arc. */
  taim: number;
  /**
   * The local player's items as its client shows them: the host's record of them, with its own
   * actions not yet settled applied on top; never sent. A remote player's stays empty: the host
   * keeps its items.
   */
  inventory: Inventory;
  /**
   * The slot the player holds, or null for holding nothing: the local player's as selected, a
   * remote player's on the host as the player last steered.
   */
  held: HeldSlot;
  /**
   * Each content entry's state for this player, in its wire form, read and written through the
   * entry's `PlayerData`. An entry with nothing here reads as its initial value.
   */
  readonly content: Map<PlayerData<unknown>, unknown>;
  /** As the player's simulation has it: the host sends it with the rest of the player's state. */
  stamina: Stamina;
  /** The player's latest item use, as this client saw it; never sent over the network. */
  use: ItemUse | null;
  /** Seconds until the player's next footstep while it moves; never sent over the network. */
  stride: number;
  /** Seconds until the player's next voice noise while its speech carries; never sent over the network. */
  voiceGap: number;
  /** Whether the player is crouching. */
  crouched: boolean;
  /** The dash under way, if any: its own lunge, or a knockback. */
  dash: Dash | null;
  /** The vehicle it drives, if any: it is where the vehicle is, and its steps drive it. */
  ride: Ride | null;
}

/** A player at rest at `at`. */
export function createPlayer(
  id: string,
  name: string,
  at: Point,
  rules: PlayerRules,
): Player {
  const position = { x: at.x, y: at.y };
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
    inventory: createInventory(rules.player.inventorySlots),
    held: 0,
    content: new Map(),
    stamina: createStamina(rules.stamina),
    use: null,
    stride: 0,
    voiceGap: 0,
    crouched: false,
    dash: null,
    ride: null,
    health: rules.player.maxHealth,
    maxHealth: rules.player.maxHealth,
  };
}

/**
 * Steps `player`'s gait under `gait`: a crouch press toggles crouching, and sprinting, which
 * needs moving with stamina to spend, stands it up. A crouching player crouches whether it moves
 * or not.
 */
function stepGait(player: Player, gait: Gait, moving: boolean): MovementMode {
  if (gait.crouch) player.crouched = !player.crouched;
  if (gait.sprint && moving && canSprint(player.stamina)) {
    player.crouched = false;
    return "sprint";
  }
  return player.crouched ? "crouch" : "walk";
}

/** A gait's top speed as a multiple of the walking speed. */
function speedFactor(mode: MovementMode, config: PlayerConfig): number {
  switch (mode) {
    case "walk":
      return 1;
    case "sprint":
      return config.sprintMultiplier;
    case "crouch":
      return config.crouchMultiplier;
  }
}

/**
 * Walks `player` one step of `dt` as `gait` steers it, carrying `pounds`, its stamina and top
 * speed following its gait and its top speed what it carries, stopping at walls.
 */
export function updatePlayer(
  player: Player,
  gait: Gait,
  dt: number,
  map: TileMap,
  rules: PlayerRules,
  pounds = 0,
): void {
  const { player: config } = rules;
  const moving = gait.move.x !== 0 || gait.move.y !== 0;
  const mode = stepGait(player, gait, moving);
  player.stamina = updateStamina(
    player.stamina,
    mode === "sprint",
    dt,
    rules.stamina,
  );
  movement.set(player, { mode, moving });

  const speed =
    config.speed * speedFactor(mode, config) * loadFactor(pounds, config.load);

  const targetX = gait.move.x * speed;
  const targetY = gait.move.y * speed;
  const dx = targetX - player.vx;
  const dy = targetY - player.vy;
  const distance = Math.hypot(dx, dy);
  const change = Math.min(distance, config.acceleration * dt);

  if (distance > 0) {
    player.vx += (dx / distance) * change;
    player.vy += (dy / distance) * change;
  }

  moveWithCollision(player, player.radius, dt, map, rules.world.wallBounce);
}

/**
 * Where a body of `radius` dashing `distance` pixels from `from` towards `aim` (radians) stops,
 * if `others` and the walls stay where they are.
 */
export function dashEnd(
  from: Point & { readonly radius: number },
  aim: number,
  distance: number,
  map: TileMap,
  others: readonly CollisionBody[],
): Point {
  const direction = { x: Math.cos(aim), y: Math.sin(aim) };
  const free = Math.min(distance, distanceToContact(from, direction, others));
  return lastFreePointAlong(map, from.radius, from, {
    x: from.x + direction.x * free,
    y: from.y + direction.y * free,
  });
}

/**
 * Starts `player` dashing `distance` pixels towards `aim` (radians) over `seconds`, and returns
 * where it stops if `others` and the walls stay where they are. A knockback is not cut short:
 * the player goes on with it, and its end is returned.
 */
export function startDash(
  player: Player,
  aim: number,
  distance: number,
  seconds: number,
  map: TileMap,
  others: readonly CollisionBody[],
): Point {
  const forced = player.dash?.to;
  if (forced !== undefined) return forced;
  const speed = distance / seconds;
  player.dash = {
    vx: Math.cos(aim) * speed,
    vy: Math.sin(aim) * speed,
    seconds,
  };
  return dashEnd(player, aim, distance, map, others);
}

/**
 * Moves `player` along its dash for `dt`, stopping at walls and short of touching any of
 * `others`, and ends the dash once its time has run, at its end if it has one.
 */
export function stepDash(
  player: Player,
  dt: number,
  map: TileMap,
  others: readonly CollisionBody[],
): void {
  const { dash } = player;
  if (dash === null) return;
  const speed = Math.hypot(dash.vx, dash.vy);
  // A knockback blocked where it starts has no speed, and holds the player where it stands.
  const direction =
    speed === 0 ? { x: 0, y: 0 } : { x: dash.vx / speed, y: dash.vy / speed };
  const travel =
    speed === 0
      ? 0
      : Math.min(
          speed * Math.min(dt, dash.seconds),
          distanceToContact(player, direction, others),
        );
  const body = {
    x: player.x,
    y: player.y,
    vx: direction.x * travel,
    vy: direction.y * travel,
  };
  moveWithCollision(body, player.radius, 1, map, 0);
  const seconds = dash.seconds - dt;
  const end = seconds > 0 ? body : (dash.to ?? body);
  player.x = end.x;
  player.y = end.y;
  player.dash = seconds > 0 ? { ...dash, seconds } : null;
}

/** The facing, in radians, from `from` towards `target`. */
export function aimAt(from: Point, target: Point): number {
  return Math.atan2(target.y - from.y, target.x - from.x);
}

/**
 * Eases a player this client does not run towards where the host last put it, and its facing
 * towards the one it last reported; `rate` is per second.
 */
export function smoothPlayer(player: Player, dt: number, rate: number): void {
  const amount = 1 - Math.exp(-rate * dt);
  easeToTarget(player, amount);
  player.aim = lerpAngle(player.aim, player.taim, amount);
}
