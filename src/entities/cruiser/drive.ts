import { minBy } from "lodash-es";
import { z } from "zod";
import {
  changeEntity,
  destroyWalls,
  driverOf,
  effect,
  eject,
  hasKindTag,
  hurt,
  INERT_TAG,
  push,
  rounded,
} from "../../sim/index.js";
import type {
  Handling,
  Impact,
  Player,
  Point,
  Session,
  VehicleSpec,
  WorldEntity,
} from "../../sim/index.js";
// Its engine, crash and breakdown sounds, once their assets land; importing a missing file breaks
// the build. Until then each makes its noise without a sound.
// import idleUrl from "./sfx/idle.mp3";
// import engineUrl from "./sfx/engine.mp3";
// import crashUrl from "./sfx/crash.mp3";
// import ramUrl from "./sfx/ram.mp3";
// import breakdownUrl from "./sfx/breakdown.mp3";

/** How often the engine is heard, and how far. Seconds, pixels. */
interface EngineBeat {
  readonly interval: number;
  readonly radius: number;
}

/** How the cruiser drives, crashes and rams. Distances in pixels, speeds in pixels per second. */
export interface DrivingConfig {
  readonly handling: Handling;
  /** How far past touching the cruiser's body a player may get in. */
  readonly reach: number;
  /** Seconds of fuel burnt each second it moves. */
  readonly burn: number;
  /** Seconds of fuel its gauge shows as full; it holds more. */
  readonly gauge: number;
  /** Its engine: quietly while it stands fuelled, loud while it is driven. */
  readonly engine: { readonly idle: EngineBeat; readonly drive: EngineBeat };
  /** Hitting a wall. */
  readonly crash: {
    /** Speed lost against a wall from which it is a crash, knocking the wall down. */
    readonly speed: number;
    /** Damage the cruiser takes each crash. */
    readonly damage: number;
    /** Damage at which it breaks down: its driver gets out and its fuel is gone. */
    readonly breakdown: number;
    /** How far a crash is heard. */
    readonly noiseRadius: number;
  };
  /** Driving into bodies. */
  readonly ram: {
    /** Least speed at which it hurts what it hits. */
    readonly speed: number;
    readonly damage: number;
    /** Least time between two hits on one body, in sim seconds. */
    readonly cooldown: number;
    /** How far a hit is heard. */
    readonly noiseRadius: number;
  };
}

/** The tag the engine's noise carries, past its maker's kind. */
const ENGINE_TAG = "engine";

/** Slower than this, in pixels per second, the cruiser counts as standing: it burns no fuel. */
const MOVING = 1;

/**
 * The cruiser's state: seconds of driving its fuel has left, unpowered at 0; damage taken since
 * it last broke down; and the way its front points, in radians.
 */
export const CruiserState = z.object({
  fuel: rounded(2, z.number().min(0)),
  damage: z.number().min(0),
  heading: rounded(3),
});
export type CruiserState = z.output<typeof CruiserState>;

/** A cruiser new to the world: unfuelled, undamaged, pointing right, towards the exit. */
export const FRESH: CruiserState = { fuel: 0, damage: 0, heading: 0 };

/** `vehicle`'s state, or a fresh one if it does not parse. */
function stateOf(vehicle: WorldEntity): CruiserState {
  const parsed = CruiserState.safeParse(vehicle.data);
  return parsed.success ? parsed.data : FRESH;
}

/** Whether `vehicle` has fuel to run on. */
const isPowered = (vehicle: WorldEntity): boolean => stateOf(vehicle).fuel > 0;

/** What makes the cruiser a vehicle: it runs on fuel and knocks down the walls it crashes into. */
export function vehicle(config: DrivingConfig): VehicleSpec {
  return {
    handling: config.handling,
    reach: config.reach,
    crashSpeed: config.crash.speed,
    heading: (entity) => stateOf(entity).heading,
    canBoard: (_game, entity) => isPowered(entity),
    powered: isPowered,
    crash(game, entity, driver, impact) {
      crash(game, entity, driver, impact, config);
    },
  };
}

/**
 * A crash: the walls its body ran into come down, it takes its crash damage, and every client
 * sees and hears it.
 */
function crash(
  game: Session,
  entity: WorldEntity,
  driver: Player,
  impact: Impact,
  config: DrivingConfig,
): void {
  destroyWalls(game, impact.area);
  changeEntity(game, entity, (data) => {
    const state = CruiserState.parse(data);
    return { ...state, damage: state.damage + config.crash.damage };
  });
  effect(
    game,
    {
      at: impact.area.center,
      flash: { radius: entity.radius, hit: true },
      noise: config.crash.noiseRadius,
      // sound: crashSound,
    },
    driver,
  );
}

/** When each body was last rammed, on the world's clock, by body id, per session. */
const rammed = new WeakMap<Session, Map<string, number>>();

/** Every body the cruiser at `at` overlaps that it may ram: players but its driver, and living entities. */
function struck(
  game: Session,
  entity: WorldEntity,
  driver: Player,
): (Player | WorldEntity)[] {
  const bodies = [
    ...game.players.values(),
    ...[...game.entities.values()].filter(
      (other) =>
        other.collides &&
        other !== entity &&
        !hasKindTag(game, other.id, [INERT_TAG]),
    ),
  ];
  return bodies.filter(
    (body) =>
      body !== driver &&
      Math.hypot(body.x - entity.x, body.y - entity.y) <
        entity.radius + body.radius,
  );
}

/**
 * Hurts every body the cruiser, going at `speed` or faster, drives into, at most once each ram
 * cooldown, and shoves it aside, clear of the cruiser's side, so the cruiser goes on past it.
 */
function ram(
  game: Session,
  entity: WorldEntity,
  driver: Player,
  speed: number,
  heading: number,
  config: DrivingConfig,
): void {
  if (Math.abs(speed) < config.ram.speed) return;
  const last = rammed.get(game) ?? new Map<string, number>();
  rammed.set(game, last);
  const across = { x: -Math.sin(heading), y: Math.cos(heading) };
  for (const body of struck(game, entity, driver)) {
    if (game.worldTime < (last.get(body.id) ?? -Infinity) + config.ram.cooldown)
      continue;
    last.set(body.id, game.worldTime);
    const offset =
      (body.x - entity.x) * across.x + (body.y - entity.y) * across.y;
    const side = offset < 0 ? -1 : 1;
    const from: Point = {
      x: body.x - across.x * side,
      y: body.y - across.y * side,
    };
    hurt(game, body, config.ram.damage);
    push(
      game,
      body,
      from,
      entity.radius + body.radius - Math.abs(offset) + 1,
      "stop",
    );
    effect(
      game,
      {
        at: { x: body.x, y: body.y },
        flash: { radius: body.radius * 2, hit: true },
        noise: config.ram.noiseRadius,
        // sound: ramSound,
      },
      driver,
    );
  }
}

/** When each cruiser's engine is next heard, on the world's clock, by entity id, per session. */
const nextBeat = new WeakMap<Session, Map<string, number>>();

/**
 * The engine, while it has fuel: a quiet beat as it stands, a loud one, made by its driver, while
 * it is driven. Zombies pay a standing cruiser no mind, but hear one driven as they would its
 * driver.
 */
function runEngine(
  game: Session,
  entity: WorldEntity,
  driving: Player | null,
  config: DrivingConfig,
): void {
  const beats = nextBeat.get(game) ?? new Map<string, number>();
  nextBeat.set(game, beats);
  if (!isPowered(entity)) {
    beats.delete(entity.id);
    return;
  }
  if (game.worldTime < (beats.get(entity.id) ?? -Infinity)) return;
  const beat = driving === null ? config.engine.idle : config.engine.drive;
  beats.set(entity.id, game.worldTime + beat.interval);
  effect(
    game,
    {
      at: { x: entity.x, y: entity.y },
      noise: beat.radius,
      tags: [ENGINE_TAG],
      // sound: driving === null ? idleSound : engineSound,
    },
    driving ?? entity,
  );
}

/**
 * The cruiser's step on the host: it goes where its driver has driven it, burning fuel as it
 * moves and ramming what it drives into, and runs its engine. Once its damage reaches breakdown,
 * its driver gets out and its fuel is gone. Returns its next state.
 */
export function stepCruiser(
  game: Session,
  entity: WorldEntity,
  state: CruiserState,
  dt: number,
  config: DrivingConfig,
): CruiserState {
  entity.vx = 0;
  entity.vy = 0;
  if (state.damage >= config.crash.breakdown) {
    eject(game, entity);
    effect(
      game,
      {
        at: { x: entity.x, y: entity.y },
        flash: { radius: entity.radius, hit: false },
        // sound: breakdownSound,
      },
      entity,
    );
    return { ...state, fuel: 0, damage: 0 };
  }
  const driver = driverOf(game, entity.id);
  const ride = driver?.ride ?? null;
  if (driver === null || ride === null) {
    runEngine(game, entity, null, config);
    return state;
  }
  entity.x = driver.x;
  entity.y = driver.y;
  const moving = Math.abs(ride.speed) > MOVING;
  const fuel = moving ? Math.max(0, state.fuel - config.burn * dt) : state.fuel;
  ram(game, entity, driver, ride.speed, ride.heading, config);
  runEngine(game, entity, moving ? driver : null, config);
  return { ...state, fuel, heading: ride.heading };
}

/** The cruiser nearest `at`, within `reach` of touching its body; null for none. */
export function cruiserNear(
  game: Session,
  kind: string,
  at: Point & { readonly radius: number },
  reach: number,
): WorldEntity | null {
  const id = game.kindIds.get(kind);
  const distance = (entity: WorldEntity): number =>
    Math.hypot(entity.x - at.x, entity.y - at.y);
  const near = [...game.entities.values()].filter(
    (entity) =>
      entity.kind === id &&
      distance(entity) <= entity.radius + at.radius + reach,
  );
  return minBy(near, distance) ?? null;
}

/** Pours `seconds` of driving into `cruiser`'s fuel, which only the host does. */
export function refuel(
  game: Session,
  cruiser: WorldEntity,
  seconds: number,
): void {
  changeEntity(game, cruiser, (data) => {
    const state = CruiserState.parse(data);
    return { ...state, fuel: state.fuel + seconds };
  });
}
