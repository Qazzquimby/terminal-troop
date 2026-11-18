import { minBy } from "lodash-es";
import { z } from "zod";
import {
  axesOf,
  changeEntity,
  destroyWalls,
  driverOf,
  effect,
  footprintOf,
  gapTo,
  hasKindTag,
  hurt,
  INERT_TAG,
  playersOutside,
  push,
  reachAlong,
  rounded,
  sound,
  touches,
  unseat,
} from "../../sim/index.js";
import type {
  Body,
  Footprint,
  Handling,
  Impact,
  Player,
  Playing,
  Point,
  Session,
  VehicleSpec,
  WorldEntity,
} from "../../sim/index.js";
// Its engine, crash and breakdown sounds, once their assets land; importing a missing file breaks
// the build. Until then each makes its noise without a sound.
import idleUrl from "./sfx/idle.mp3";
import engineUrl from "./sfx/engine.mp3";
import reverseUrl from "./sfx/reverse.mp3";
import crashUrl from "./sfx/crash.mp3";
import ramUrl from "./sfx/ram.mp3";
// import breakdownUrl from "./sfx/breakdown.mp3";
import hornUrl from "./sfx/horn.mp3";

/** What its engine is doing: stopped, idling, driven forward or backing up. */
const EngineRun = z.enum(["off", "idle", "drive", "reverse"]);
type EngineRun = z.output<typeof EngineRun>;

/**
 * The long sound its engine holds while it runs, by what it is doing, looped from its start each
 * time that changes. Range in pixels.
 */
const engineSounds: Record<
  Exclude<EngineRun, "off">,
  { readonly url: string; readonly volume: number; readonly range: number }
> = {
  idle: { url: idleUrl, volume: 0.05, range: 6 },
  drive: { url: engineUrl, volume: 0.4, range: 20 },
  reverse: { url: reverseUrl, volume: 0.4, range: 20 },
};
const crashSound = sound({
  url: crashUrl,
  volume: 0.8,
  range: 34,
});
const ramSound = sound({
  url: ramUrl,
  volume: 0.5,
  range: 22,
});

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
  /**
   * Slower than this, it counts as standing: it burns no fuel and its engine idles. Throttled
   * nose-first into a wall it creeps along at a few pixels a second, which is standing.
   */
  readonly standing: number;
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
    /** Damage at which it breaks down: its driver loses the wheel and its fuel is gone. */
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
  /** Its horn, sounded by anyone inside it. */
  readonly horn: {
    /** How far it is heard, in pixels. */
    readonly noiseRadius: number;
    /** How loud it plays, 0..1. */
    readonly volume: number;
  };
}

/** The tag the engine's noise carries, past its maker's kind. */
const ENGINE_TAG = "engine";

/**
 * The cruiser's state: seconds of driving its fuel has left, unpowered at 0; damage taken since
 * it last broke down; the way its front points, in radians; the station its radio plays, null
 * while it is off; whether its door is shut; the power its door has left, 0..1 of full; and what
 * its engine is doing, and since when on the world's clock.
 */
export const CruiserState = z.object({
  fuel: rounded(2, z.number().min(0)),
  damage: z.number().min(0),
  heading: rounded(3),
  station: z.number().int().min(0).nullable().default(null),
  shut: z.boolean().default(false),
  charge: rounded(2, z.number().min(0).max(1)).default(1),
  engine: EngineRun.default("off"),
  revved: rounded(2).default(0),
});
export type CruiserState = z.output<typeof CruiserState>;

/**
 * A cruiser new to the world: unfuelled, undamaged, pointing right, towards the exit, radio off,
 * door open on full power, engine off.
 */
export const FRESH: CruiserState = {
  fuel: 0,
  damage: 0,
  heading: 0,
  station: null,
  shut: false,
  charge: 1,
  engine: "off",
  revved: 0,
};

/** `vehicle`'s state, or a fresh one if it does not parse. */
function stateOf(vehicle: WorldEntity): CruiserState {
  const parsed = CruiserState.safeParse(vehicle.data);
  return parsed.success ? parsed.data : FRESH;
}

/** Whether `vehicle` has fuel to run on. */
const isPowered = (vehicle: WorldEntity): boolean => stateOf(vehicle).fuel > 0;

/**
 * What makes the cruiser a vehicle: anyone may get in, fuel or none, but it runs on fuel, knocks
 * down the walls it crashes into, and has a horn.
 */
export function vehicle(config: DrivingConfig): VehicleSpec {
  const hornSound = sound({
    url: hornUrl,
    volume: config.horn.volume,
    range: config.horn.noiseRadius,
  });
  return {
    handling: config.handling,
    reach: config.reach,
    crashSpeed: config.crash.speed,
    heading: (entity) => stateOf(entity).heading,
    powered: isPowered,
    crash(game, entity, driver, impact) {
      crash(game, entity, driver, impact, config);
    },
    honk(game, entity) {
      effect(game, {
        at: { x: entity.x, y: entity.y },
        noise: config.horn.noiseRadius,
        tags: [HORN_TAG],
        sound: hornSound,
      });
    },
  };
}

/** The tag the horn's noise carries, past its maker's kind. */
const HORN_TAG = "horn";

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
      sound: crashSound,
    },
    driver,
  );
}

/** When each body was last rammed, on the world's clock, by body id, per session. */
const rammed = new WeakMap<Session, Map<string, number>>();

/** `vehicle`'s footprint, its box turned to `heading`, the way its driver now points it. */
function turnedTo(
  game: Session,
  vehicle: WorldEntity,
  heading: number,
): Footprint {
  const { box, ...disc } = footprintOf(game, vehicle);
  return box === null || box === undefined
    ? disc
    : { ...disc, box: { ...box, heading } };
}

/**
 * Every body the cruiser's footprint, `body`, overlaps that it may ram: players out in the world,
 * not those inside it or any other vehicle, and living entities.
 */
function struck(
  game: Session,
  entity: WorldEntity,
  body: Footprint,
  driver: Player,
): Body[] {
  const bodies = [
    ...playersOutside(game),
    ...[...game.entities.values()].filter(
      (other) =>
        other.collides &&
        other !== entity &&
        !hasKindTag(game, other.id, [INERT_TAG]),
    ),
  ];
  return bodies.filter(
    (other) => other !== driver && touches(body, other, other.radius),
  );
}

/**
 * Hurts every body the cruiser, going at `speed` or faster, drives into, nose or side, at most
 * once each ram cooldown, and shoves it aside, clear of the cruiser's side, so the cruiser goes on
 * past it.
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
  const footprint = turnedTo(game, entity, heading);
  const { across } = axesOf(heading);
  const flank = reachAlong(footprint, across);
  for (const body of struck(game, entity, footprint, driver)) {
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
    hurt(game, body, config.ram.damage, driver.id);
    push(game, body, from, flank + body.radius - Math.abs(offset) + 1, {
      by: entity,
    });
    effect(
      game,
      {
        at: { x: body.x, y: body.y },
        flash: { radius: body.radius * 2, hit: true },
        noise: config.ram.noiseRadius,
        sound: ramSound,
      },
      driver,
    );
  }
}

/** When each cruiser's engine next makes its noise, on the world's clock, by entity id, per session. */
const nextBeat = new WeakMap<Session, Map<string, number>>();

/**
 * What the engine of a cruiser in `state` does now: off without fuel, idling as it stands, and
 * otherwise driven forward or backing up as its `speed` goes; null for no one at the wheel.
 */
function engineRun(
  state: CruiserState,
  speed: number | null,
  config: DrivingConfig,
): EngineRun {
  if (state.fuel <= 0) return "off";
  if (speed === null || Math.abs(speed) <= config.standing) return "idle";
  return speed > 0 ? "drive" : "reverse";
}

/** `state` with its engine doing `run`, since now if that is a change. */
function revTo(
  game: Session,
  state: CruiserState,
  run: EngineRun,
): CruiserState {
  return run === state.engine
    ? state
    : { ...state, engine: run, revved: game.worldTime };
}

/**
 * The engine's noise, while it runs: a quiet beat as it idles, a loud one, made by its driver,
 * while it is driven either way. Zombies pay a standing cruiser no mind, but hear one driven as
 * they would its driver. What clients hear of it is `enginePlaying`.
 */
function runEngine(
  game: Session,
  entity: WorldEntity,
  run: EngineRun,
  driver: Player | null,
  config: DrivingConfig,
): void {
  const beats = nextBeat.get(game) ?? new Map<string, number>();
  nextBeat.set(game, beats);
  if (run === "off") {
    beats.delete(entity.id);
    return;
  }
  if (game.worldTime < (beats.get(entity.id) ?? -Infinity)) return;
  const beat = run === "idle" ? config.engine.idle : config.engine.drive;
  beats.set(entity.id, game.worldTime + beat.interval);
  effect(
    game,
    {
      at: { x: entity.x, y: entity.y },
      noise: beat.radius,
      tags: [ENGINE_TAG],
    },
    run === "idle" || driver === null ? entity : driver,
  );
}

/**
 * The engine's sound on every client, while it runs: one long sound looped for as long as it
 * idles, drives or backs up, from its start each time that changes, so a client coming upon it
 * joins it where the world's clock has it.
 */
export function enginePlaying(state: CruiserState): Playing | null {
  if (state.engine === "off") return null;
  const { url, volume, range } = engineSounds[state.engine];
  return {
    key: `engine/${state.engine}`,
    url,
    since: state.revved,
    volume,
    range,
    loop: true,
  };
}

/**
 * The cruiser's step on the host: it goes where its driver has driven it, burning fuel as it
 * moves and ramming what it drives into, and runs its engine. Once its damage reaches breakdown,
 * its driver loses the wheel, staying inside, and its fuel is gone. Returns its next state.
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
    unseat(game, entity);
    effect(
      game,
      {
        at: { x: entity.x, y: entity.y },
        flash: { radius: entity.radius, hit: false },
        // sound: breakdownSound,
      },
      entity,
    );
    return revTo(game, { ...state, fuel: 0, damage: 0 }, "off");
  }
  const driver = driverOf(game, entity.id);
  const ride = driver?.ride ?? null;
  if (driver === null || ride === null) {
    const run = engineRun(state, null, config);
    runEngine(game, entity, run, null, config);
    return revTo(game, state, run);
  }
  entity.x = driver.x;
  entity.y = driver.y;
  const moving = Math.abs(ride.speed) > config.standing;
  const fuel = moving ? Math.max(0, state.fuel - config.burn * dt) : state.fuel;
  ram(game, entity, driver, ride.speed, ride.heading, config);
  const next = { ...state, fuel, heading: ride.heading };
  const run = engineRun(next, ride.speed, config);
  runEngine(game, entity, run, driver, config);
  return revTo(game, next, run);
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
    gapTo(footprintOf(game, entity), at);
  const near = [...game.entities.values()].filter(
    (entity) => entity.kind === id && distance(entity) <= at.radius + reach,
  );
  return minBy(near, distance) ?? null;
}

/**
 * Pours `seconds` of driving into `cruiser`'s fuel and mends it, its crash damage cleared, which
 * only the host does. Its health needs no mending: it has no end, so nothing wears it down.
 */
export function refuel(
  game: Session,
  cruiser: WorldEntity,
  seconds: number,
): void {
  changeEntity(game, cruiser, (data) => {
    const state = CruiserState.parse(data);
    return { ...state, fuel: state.fuel + seconds, damage: 0 };
  });
}
