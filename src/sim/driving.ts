import { z } from "zod";
import { moveWithCollision } from "./collision.js";
import type { WorldEntity } from "./entities.js";
import type { Point } from "./map.js";
import { movement } from "./movement.js";
import type { Player, PlayerRules } from "./player.js";
import type { Session } from "./session.js";
import { moveBox, nudgeBoxFree, turnBox } from "./shape.js";
import type { BoxSize } from "./shape.js";
import { updateStamina } from "./stamina.js";
import type { WallArea } from "./walls.js";

/**
 * A player at the wheel of a vehicle: which, the way it points, and how fast it goes along that
 * way. While it rides, the player is where the vehicle is: its steps drive the vehicle rather
 * than walk, on every client that runs it, and the host puts the vehicle where the player is.
 */
export interface Ride {
  /** The vehicle's entity id. */
  readonly vehicle: string;
  /** Radians, the way its front points. */
  readonly heading: number;
  /** Pixels per second along its heading; negative in reverse. */
  readonly speed: number;
}

export const RideWire = z
  .object({
    vehicle: z.string().min(1).max(80),
    heading: z.number(),
    speed: z.number(),
  })
  .nullable();

/** How a vehicle drives, like a car. Speeds in pixels per second, rates per second. */
export interface Handling {
  /** Top speed forwards. */
  readonly speed: number;
  /** Top speed in reverse. */
  readonly reverse: number;
  /** Speed gained each second under full throttle. */
  readonly acceleration: number;
  /** Speed lost each second while throttling against the way it goes. */
  readonly braking: number;
  /** Speed lost each second with no throttle. */
  readonly drag: number;
  /** Radians it turns each second at full lock, once at `grip` speed or faster. */
  readonly turnRate: number;
  /** The speed from which it turns at its full rate; slower, it turns slower, and not at all at rest. */
  readonly grip: number;
}

/** What a vehicle hits a wall with, hard enough to crash. */
export interface Impact {
  /** The speed it lost against the wall, in pixels per second. */
  readonly speed: number;
  /** Where its body would have gone on to, had the wall not stopped it. */
  readonly area: WallArea;
}

/**
 * What makes a kind of entity a vehicle a player can drive: get in with interact beside it while
 * no one else drives it, out again with interact. Only the driver rides it.
 */
export interface VehicleSpec {
  readonly handling: Handling;
  /** How far past touching its body a player may get in, in pixels. */
  readonly reach: number;
  /**
   * Speed lost against a wall, in pixels per second, from which hitting it is a crash: the
   * vehicle stops dead there, rather than sliding along it.
   */
  readonly crashSpeed: number;
  /** The way the vehicle points as it stands, in radians, which a new driver takes. */
  heading(vehicle: WorldEntity): number;
  /** Whether a player may get in now; always when left out. Read on every client. */
  canBoard?(game: Session, vehicle: WorldEntity): boolean;
  /** Whether its throttle does anything; always when left out. Without it, it only rolls to a stop. */
  powered?(vehicle: WorldEntity): boolean;
  /**
   * Runs on the host as its driver crashes it into a wall, once, as the host first runs that
   * step; its momentum is already spent.
   */
  crash?(
    game: Session,
    vehicle: WorldEntity,
    driver: Player,
    impact: Impact,
  ): void;
}

/** The vehicle entity `id` and what makes it one, if it is one this client knows. */
export function vehicleOf(
  game: Session,
  id: string,
): { readonly entity: WorldEntity; readonly spec: VehicleSpec } | null {
  const entity = game.entities.get(id);
  const spec =
    entity === undefined
      ? undefined
      : game.entityTypes.get(entity.kind)?.vehicle;
  if (entity === undefined || spec === undefined || spec === null) return null;
  return { entity, spec };
}

/** The player driving the vehicle `id`, as this client has it; null for none. */
export function driverOf(game: Session, id: string): Player | null {
  for (const player of game.players.values())
    if (player.ride?.vehicle === id) return player;
  return null;
}

/** `value` moved towards `target` by at most `step`. */
function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  return Math.max(target, value - step);
}

const clamp = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

/** The speed a step of `dt` leaves, from `speed` under `throttle` (-1..1). */
function throttled(
  speed: number,
  throttle: number,
  handling: Handling,
  dt: number,
): number {
  if (throttle === 0) return approach(speed, 0, handling.drag * dt);
  const target =
    throttle > 0 ? handling.speed * throttle : handling.reverse * throttle;
  const against = speed !== 0 && Math.sign(speed) !== Math.sign(throttle);
  const rate = against ? handling.braking : handling.acceleration;
  return approach(speed, target, rate * dt);
}

/** How far a crash's area reaches past where the vehicle stopped, in its own radii. */
const CRASH_PROBE = 0.25;

/**
 * Pixels a turning box may be nudged past how far its corners swing, to come clear of the wall
 * it turns against.
 */
const TURN_NUDGE = 1;

/** How far a box found standing in a wall may be moved out of it, in its own widths. */
const UNSTICK = 0.25;

/**
 * One step of `player` driving its vehicle on `move`: up throttles, down brakes and reverses, and
 * sideways turns it, the more the faster it goes. It stops at walls, sliding along one it only
 * grazes, and a wall hit hard enough is a crash: it stops dead, and on a live run on the host the
 * vehicle's `crash` runs. `live` is false while a client runs again a step it has run before.
 * Without the vehicle here, the player holds still.
 */
export function drive(
  game: Session,
  player: Player,
  move: Point,
  dt: number,
  live: boolean,
  rules: PlayerRules,
): void {
  const { ride } = player;
  if (ride === null) return;
  player.dash = null;
  player.stamina = updateStamina(player.stamina, false, dt, rules.stamina);
  movement.set(player, { mode: "walk", moving: false });
  const found = vehicleOf(game, ride.vehicle);
  if (found === null || dt <= 0) {
    player.vx = 0;
    player.vy = 0;
    return;
  }
  const { entity, spec } = found;
  const { handling } = spec;
  const powered = spec.powered?.(entity) ?? true;
  const throttle = powered ? clamp(-move.y, 1) : 0;
  const speed = throttled(ride.speed, throttle, handling, dt);
  const grip = handling.grip > 0 ? clamp(speed / handling.grip, 1) : 1;
  const turned =
    ride.heading + clamp(move.x, 1) * handling.turnRate * grip * dt;
  const size = game.entityTypes.get(entity.kind)?.box(entity) ?? null;
  const step =
    size === null
      ? roll(game, entity.radius, player, turned, speed, dt)
      : rollBox(game, size, player, ride.heading, turned, speed, dt);
  const { from, to, heading } = step;
  const way = { x: Math.cos(heading), y: Math.sin(heading) };
  const moved = ((to.x - from.x) * way.x + (to.y - from.y) * way.y) / dt;
  const lost = Math.abs(speed - moved);
  const crashed = lost >= spec.crashSpeed;
  player.x = to.x;
  player.y = to.y;
  player.vx = (to.x - from.x) / dt;
  player.vy = (to.y - from.y) / dt;
  player.ride = { ...ride, heading, speed: crashed ? 0 : moved };
  if (!crashed || !live || !game.hosting) return;
  spec.crash?.(game, entity, player, {
    speed: lost,
    area: crashArea(entity.radius, size, to, way, Math.sign(speed)),
  });
}

/** Where a step of driving starts, once turned, and ends, and the way the vehicle then points. */
interface Rolled {
  readonly from: Point;
  readonly to: Point;
  readonly heading: number;
}

/** A step of a vehicle whose body is the square of half-size `radius`, which turns freely. */
function roll(
  game: Session,
  radius: number,
  at: Point,
  heading: number,
  speed: number,
  dt: number,
): Rolled {
  const from = { x: at.x, y: at.y };
  const body = {
    ...from,
    vx: Math.cos(heading) * speed,
    vy: Math.sin(heading) * speed,
  };
  moveWithCollision(body, radius, dt, game.world.map, 0);
  return { from, to: { x: body.x, y: body.y }, heading };
}

/**
 * A step of a vehicle whose body is a box of `size`. It first comes clear of any wall it stands in,
 * then turns, nudged off a wall the turn swings its corners into, or not turning at all where no
 * small nudge clears it, then rolls on, sliding along a wall it meets at a slant.
 */
function rollBox(
  game: Session,
  size: BoxSize,
  at: Point,
  heading: number,
  turned: number,
  speed: number,
  dt: number,
): Rolled {
  const { map } = game.world;
  const start = { ...size, x: at.x, y: at.y, heading };
  const clear = nudgeBoxFree(map, start, size.width * UNSTICK) ?? start;
  const swing =
    Math.abs(turned - heading) * Math.hypot(size.length, size.width);
  const placed = turnBox(
    map,
    { ...start, ...clear },
    turned,
    swing / 2 + TURN_NUDGE,
  );
  const to = moveBox(
    map,
    placed,
    Math.cos(placed.heading) * speed * dt,
    Math.sin(placed.heading) * speed * dt,
  );
  return { from: { x: placed.x, y: placed.y }, to, heading: placed.heading };
}

/**
 * The walls a crash knocks down: ahead of the vehicle's front, or its back when it reverses
 * (`sign` -1), a little past it. A box's is as wide as the box; a square body's is its square.
 */
function crashArea(
  radius: number,
  size: BoxSize | null,
  at: Point,
  way: Point,
  sign: number,
): WallArea {
  const probe = radius * CRASH_PROBE;
  const ahead =
    size === null ? probe : size.length / 2 - size.width / 2 + probe;
  return {
    center: { x: at.x + way.x * ahead * sign, y: at.y + way.y * ahead * sign },
    radius: size === null ? radius : size.width / 2,
    shape: "square",
  };
}
