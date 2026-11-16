import { z } from "zod";
import type { Body } from "./bodies.js";
import { moveWithCollision } from "./collision.js";
import type { WorldEntity } from "./entities.js";
import type { Point } from "./map.js";
import { movement } from "./movement.js";
import type { Player, PlayerRules } from "./player.js";
import type { Session } from "./session.js";
import { moveBox, nudgeBoxFree, turnBox } from "./shape.js";
import type { BoxSize } from "./shape.js";
import type { Sound } from "./sound.js";
import { updateStamina } from "./stamina.js";
import type { WallArea } from "./walls.js";

/**
 * A player inside a vehicle: which, and whether it is at the wheel. Inside, the player is where
 * the vehicle is, shut in it: nothing out in the world sees, targets, strikes or bumps into it,
 * though what it says is still heard from there. Any number may be inside, and any number of
 * those at the wheel at once. Their steers add up, each way clamped to full (see `wheelOf`), and
 * the one leading them (see `driverOf`) drives the vehicle on that sum, on every client that runs
 * it; the host puts the vehicle where the lead is. The others at the wheel go along with the lead,
 * so whichever of them leads next goes on as it went; those off the wheel sit where the vehicle is.
 */
export interface Ride {
  /** The vehicle's entity id. */
  readonly vehicle: string;
  /** Whether it is at the wheel. */
  readonly driving: boolean;
  /** Radians, the way its front points, as its driver last drove it. */
  readonly heading: number;
  /** Pixels per second along its heading; negative in reverse. 0 for one not at the wheel. */
  readonly speed: number;
  /** How far its driver turns the wheel this step, -1 to 1, right positive. 0 off the wheel. */
  readonly turn: number;
}

export const RideWire = z
  .object({
    vehicle: z.string().min(1).max(80),
    driving: z.boolean(),
    heading: z.number(),
    speed: z.number(),
    turn: z.number().min(-1).max(1),
  })
  .nullable();

/**
 * What a player inside a vehicle asks of it from its cabin: to take the wheel, sound the horn,
 * get out, tune its radio to the next station (switching it on), or switch its radio off; to stow
 * the item in its own slot `stow` in the vehicle's storage, in its slot `into` or the first empty
 * one; to take the item in the storage's slot `unstow`; to buy the item `buy` at the vehicle's
 * shop; or to teleport the body `teleport` to the vehicle.
 */
export type CabinCommand =
  | "drive"
  | "honk"
  | "exit"
  | "radio"
  | "radioOff"
  | { readonly stow: number; readonly into?: number }
  | { readonly unstow: number }
  | { readonly buy: string }
  | { readonly teleport: string };

/** What a radio is turned to: the next station along, switching it on, or off. */
export type Tuning = "next" | "off";

/**
 * A vehicle's teleporter: anyone inside sends for a body out in the world, which is brought to
 * the vehicle, by whatever means and however long it takes.
 */
export interface VehicleTeleporter {
  /**
   * The id of the body it is bringing to `vehicle` now, as this client has it; null while it is
   * free to send for one. Read on every client. It sends for one at a time.
   */
  sending(game: Session, vehicle: WorldEntity): string | null;
  /** Sends for `target`, out in the world, by `by` inside `vehicle`, as part of an action. */
  send(game: Session, vehicle: WorldEntity, by: Player, target: Body): void;
}

/** A vehicle's storage: items anyone inside may leave in it, or take out. */
export interface Storage {
  /** How many items it holds, one a slot. */
  readonly slots: number;
  /** What every client near it hears as an item goes in or out, if anything. */
  readonly sound?: Sound;
  /** How far, in pixels, the noise of an item going in or out carries; as far as its sound when left out. */
  readonly noise?: number;
}

/** One item a shop sells, and what it costs of the team's credit. */
export interface Ware {
  readonly item: string;
  readonly price: number;
}

/** A vehicle's shop: items anyone inside may buy with the team's credit. */
export interface VehicleShop {
  readonly wares: readonly Ware[];
  /** What every client near it hears on a purchase, if anything. */
  readonly sound?: Sound;
  /** How far, in pixels, a purchase's noise carries; as far as its sound when left out. */
  readonly noise?: number;
}

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
 * What makes a kind of entity a vehicle players ride in: get in with interact beside it, any
 * number at once; take the wheel, any number at once; and get out again.
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
  /** Its storage, which those inside share; none when left out. */
  readonly storage?: Storage;
  /** Its shop, where those inside buy with the team's credit; none when left out. */
  readonly shop?: VehicleShop;
  /** Its horn, sounded by `by` inside it, as part of an action: an `effect` to make. None when left out. */
  honk?(game: Session, vehicle: WorldEntity, by: Player): void;
  /**
   * Whether it carries a two-way set on the walkie band: while anyone is inside, it plays every
   * transmission there is from where it stands, as a walkie switched on would, and whoever is
   * inside may transmit on it. Never when left out.
   */
  readonly transceiver?: boolean;
  /** Its teleporter, which brings bodies to it; none when left out. */
  readonly teleporter?: VehicleTeleporter;
  /** Its radio, turned by `by` inside it, as part of an action. None when left out. */
  tune?(game: Session, vehicle: WorldEntity, by: Player, to: Tuning): void;
  /** The name of the station its radio plays, as this client has it; null while it is off. */
  station?(vehicle: WorldEntity): string | null;
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

/**
 * Every player at the wheel of the vehicle `id`, as this client has it, in the order of their ids:
 * the same order on every client, whatever order each heard of them in.
 */
export function driversOf(game: Session, id: string): Player[] {
  return [...game.players.values()]
    .filter((player) => player.ride?.vehicle === id && player.ride.driving)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The player leading those at the wheel of the vehicle `id`, as this client has it: the first by
 * id, whose steps drive the vehicle on everyone's steer. Null for no one at the wheel.
 */
export function driverOf(game: Session, id: string): Player | null {
  return driversOf(game, id)[0] ?? null;
}

/**
 * How the wheel of `player`'s vehicle is worked this step: what everyone at it steers, added up
 * and clamped each way to full. One alone steers it fully; two steering alike get no more than
 * one, and two against each other cancel out. `own` is `player`'s own steer, which its step runs
 * on; `steerOf` gives every other driver's, as this client last heard it.
 */
export function wheelOf(
  game: Session,
  player: Player,
  own: Point,
  steerOf: (other: Player) => Point,
): Point {
  const { ride } = player;
  if (ride === null) return own;
  let x = own.x;
  let y = own.y;
  for (const driver of driversOf(game, ride.vehicle)) {
    if (driver === player) continue;
    const move = steerOf(driver);
    x += move.x;
    y += move.y;
  }
  return { x: clamp(x, 1), y: clamp(y, 1) };
}

/** Every player inside the vehicle `id`, as this client has it, its driver among them. */
export function occupantsOf(game: Session, id: string): Player[] {
  return [...game.players.values()].filter(
    (player) => player.ride?.vehicle === id,
  );
}

/** The vehicle `player` is inside, if it carries a set on the walkie band; null otherwise. */
export function transceiverOf(
  game: Session,
  player: Player,
): WorldEntity | null {
  if (player.ride === null) return null;
  const found = vehicleOf(game, player.ride.vehicle);
  return found?.spec.transceiver === true ? found.entity : null;
}

/** Every vehicle carrying a set on the walkie band with anyone inside it: every set switched on. */
export function liveTransceivers(game: Session): WorldEntity[] {
  const live = new Set<WorldEntity>();
  for (const player of game.players.values()) {
    const vehicle = transceiverOf(game, player);
    if (vehicle !== null) live.add(vehicle);
  }
  return [...live];
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
 * One step of `player` inside its vehicle: off the wheel, it sits where the vehicle is. At the
 * wheel behind another who leads (see `driverOf`), it goes along with the lead: where it is,
 * pointing and going as it does. Leading, it drives on `move`, the wheel as everyone at it works
 * it (see `wheelOf`): up throttles, down brakes and reverses, and sideways turns it, the
 * more the faster it goes. It stops at walls, sliding along one it only
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
  if (found === null || dt <= 0 || !ride.driving) {
    player.vx = 0;
    player.vy = 0;
    if (found !== null && !ride.driving) {
      player.x = found.entity.x;
      player.y = found.entity.y;
    }
    return;
  }
  const lead = driverOf(game, ride.vehicle);
  if (lead !== null && lead !== player && lead.ride !== null) {
    player.x = lead.x;
    player.y = lead.y;
    player.vx = 0;
    player.vy = 0;
    player.ride = {
      ...ride,
      heading: lead.ride.heading,
      speed: lead.ride.speed,
      turn: lead.ride.turn,
    };
    return;
  }
  const { entity, spec } = found;
  const { handling } = spec;
  const powered = spec.powered?.(entity) ?? true;
  const throttle = powered ? clamp(-move.y, 1) : 0;
  const speed = throttled(ride.speed, throttle, handling, dt);
  const grip = handling.grip > 0 ? clamp(speed / handling.grip, 1) : 1;
  const turn = clamp(move.x, 1);
  const turned = ride.heading + turn * handling.turnRate * grip * dt;
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
  player.ride = { ...ride, heading, speed: crashed ? 0 : moved, turn };
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
