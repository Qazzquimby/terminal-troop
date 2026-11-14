import { z } from "zod";
import alertUrl from "./sfx/alert.mp3";
import attackUrl from "./sfx/attack.mp3";
import barkUrl from "./sfx/bark.mp3";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  canSeeFrom,
  livingPlayers,
  defineEntity,
  directionalVision,
  effect,
  hasKindTag,
  INERT_TAG,
  ITEM_TAG,
  isAreaFree,
  mulberry32Next,
  noisesHeardBy,
  rounded,
  sound,
  spawn,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Heard,
  Point,
  Rng,
  Scatter,
  Session,
  Sound,
  Strike,
  TileMap,
  WorldEntity,
} from "../../sim/index.js";
import { MAX_WAYPOINTS, planRoute, steer } from "../route.js";
import { spawnWeight, spawning, stepSpawning } from "./spawning.js";
import type { SpawningConfig } from "./spawning.js";

/**
 * How a zombie moves and hunts, and how many a new world starts with. Distances are in pixels,
 * speeds in pixels per second.
 */
export interface ZombieConfig {
  readonly spawn: Scatter;
  /** How more keep arriving once the world has begun. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** Health when at full. */
  readonly maxHealth: number;
  /** Damage dealt to each player or other prey within attack range. */
  readonly attackDamage: number;
  readonly wanderSpeed: number;
  readonly chaseSpeed: number;
  /** How far a zombie sees prey it has a clear line to within its sight cone. */
  readonly sightRange: number;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds a zombie stands after a wander leg or a lost chase, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** How far sighted prey must be from where the chase is headed before it plans anew. */
  readonly repathDistance: number;
  /** Seconds between barks, drawn between the two after each one. */
  readonly barkGap: { readonly min: number; readonly max: number };
  /** How close to its target a chasing zombie must be to attack. */
  readonly attackRange: number;
  /** Seconds between attacks. */
  readonly attackCooldown: number;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly bark: number;
    readonly alert: number;
    readonly attack: number;
  };
}

/** A point, sent to a tenth of a pixel. */
const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

const Route = z.array(Waypoint).max(MAX_WAYPOINTS);

/** A mulberry32 state. */
const Seed = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);

/**
 * What a zombie keeps whichever mode it is in. Snapshots carry only the fields that changed, so
 * its timers are deadlines on the world's clock, which change only when set. Each field says who
 * reads it: everyone, to draw it, or only the host, which sends it so that whoever hosts next goes
 * on from it. Its sounds reach every client as effects, not through its state.
 */
const Shared = {
  /** When it next barks. Host. */
  barkAt: Time,
  /** When it may next attack. Host. */
  attackAt: Time,
  /** Whether it attacks in this step. Host. */
  attacking: z.boolean(),
  /** Host. */
  seed: Seed,
  /** Host. */
  route: Route,
  /** Where a chase is headed, or null while wandering. Host. */
  target: Waypoint.nullable(),
  /** Radians, sent to a hundredth. Everyone. */
  facing: rounded(2),
};

/**
 * Everyone reads the mode, to colour the zombie.
 * - wander: walks `route`, then stands until `standUntil`, set once it stops (host), then picks
 *   a new leg; a heard noise turns its route towards `noiseTarget` (everyone), where the noise
 *   seemed to come from
 * - chase: heads along `route` for `target`, where prey was last seen
 */
export const ZombieState = z.discriminatedUnion("mode", [
  z.object({
    ...Shared,
    mode: z.literal("wander"),
    standUntil: Time.nullable(),
    noiseTarget: Waypoint.nullable(),
  }),
  z.object({ ...Shared, mode: z.literal("chase") }),
]);

export type ZombieState = z.output<typeof ZombieState>;

type Wander = Extract<ZombieState, { mode: "wander" }>;

/** Random points tried for a wander leg before standing a while longer. */
const LEG_ATTEMPTS = 8;

const COLOURS = {
  wander: "#7d9a52",
  listen: "#d8a13a",
  chase: "#d8473a",
} as const;

const ZOMBIE_GLYPH = "🧟";

/** The kind's name. */
const NAME = "zombie";

/**
 * The kind tags a zombie pays no mind: other zombies, whether it hears them or sees them, and
 * what is not worth hunting.
 */
const IGNORES = [NAME, INERT_TAG];

/** A fresh zombie's state at world time `now`, its random draws seeded by `seed`. */
export function freshZombie(
  seed: number,
  now: number,
  config: ZombieConfig,
): ZombieState {
  const { result, seed: next } = withSeed(seed | 0, (rng) =>
    barkGap(rng, config),
  );
  return {
    mode: "wander",
    seed: next,
    route: [],
    target: null,
    standUntil: now,
    noiseTarget: null,
    barkAt: now + result,
    attackAt: now,
    attacking: false,
    facing: 0,
  };
}

/** Runs `draw` with a generator seeded by `seed`, and returns its result and the state after it. */
function withSeed<T>(
  seed: number,
  draw: (rng: Rng) => T,
): { result: T; seed: number } {
  let state = seed;
  const result = draw(() => {
    const next = mulberry32Next(state);
    state = next.state;
    return next.value;
  });
  return { result, seed: state };
}

/** A body a zombie may hunt. */
interface Prey extends Point {
  readonly id: string;
  readonly radius: number;
}

/**
 * Every player and world entity within `reach` of `hunter` that it hunts: anything but zombies
 * and what the world tags as not worth hunting.
 */
function preyNear(
  game: Session,
  hunter: Prey,
  reach: (prey: Prey) => number,
): Prey[] {
  const near: Prey[] = [];
  const bodies = [...livingPlayers(game), ...game.entities.values()];
  for (const body of bodies) {
    if (body.id === hunter.id) continue;
    const distance = Math.hypot(body.x - hunter.x, body.y - hunter.y);
    if (distance > reach(body)) continue;
    if (hasKindTag(game, body.id, [...IGNORES, ITEM_TAG])) continue;
    near.push(body);
  }
  return near;
}

/** The nearest prey a zombie sees within its cone or surroundings, or null. */
function sighting(
  game: Session,
  self: Prey,
  range: number,
  facing: number,
): Point | null {
  const sources = directionalVision(self, facing, game.config.vision, range);
  let nearest: Point | null = null;
  let nearestDistance = Infinity;
  for (const prey of preyNear(game, self, () => range)) {
    const distance = Math.hypot(prey.x - self.x, prey.y - self.y);
    if (
      distance < nearestDistance &&
      sources.some((source) => canSeeFrom(game.world.map, source, prey))
    ) {
      nearest = { x: prey.x, y: prey.y };
      nearestDistance = distance;
    }
  }
  return nearest;
}

function pauseLength(rng: Rng, config: ZombieConfig): number {
  const { min, max } = config.wanderPause;
  return min + (max - min) * rng();
}

function barkGap(rng: Rng, config: ZombieConfig): number {
  const { min, max } = config.barkGap;
  return min + (max - min) * rng();
}

/** A route to a random free point within the wander range, or null when none of the tries finds one. */
function wanderLeg(
  map: TileMap,
  at: Point,
  rng: Rng,
  config: ZombieConfig,
): Point[] | null {
  for (let attempt = 0; attempt < LEG_ATTEMPTS; attempt++) {
    const angle = rng() * Math.PI * 2;
    const distance = config.wanderRange * Math.sqrt(rng());
    const to = {
      x: at.x + Math.cos(angle) * distance,
      y: at.y + Math.sin(angle) * distance,
    };
    if (!isAreaFree(map, to.x, to.y, config.radius)) continue;
    const route = planRoute(map, config.radius, at, to);
    if (route !== null && route.length > 0) return route;
  }
  return null;
}

/**
 * The clearest noise a zombie at `at` hears this step, or null, and its seed after listening. It
 * ignores other zombies' noise, its own included.
 */
function listen(
  state: Wander,
  at: Point,
  game: Session,
): { result: Heard | null; seed: number } {
  return withSeed(state.seed, (rng) => {
    let clearest: Heard | null = null;
    for (const heard of noisesHeardBy(game, { at, rng, ignores: IGNORES })) {
      if (clearest === null || heard.clarity > clearest.clarity)
        clearest = heard;
    }
    return clearest;
  });
}

/**
 * Heads for `heard`, planning anew unless the route already heads close enough to it, and
 * stands a while once there. A noise no route reaches is ignored.
 */
function investigate(
  state: Wander,
  at: Point,
  heard: Point,
  map: TileMap,
  config: ZombieConfig,
): Wander {
  const { noiseTarget } = state;
  if (
    noiseTarget !== null &&
    state.route.length > 0 &&
    Math.hypot(noiseTarget.x - heard.x, noiseTarget.y - heard.y) <=
      config.repathDistance
  )
    return state;
  const route = planRoute(map, config.radius, at, heard);
  if (route === null || route.length === 0) return state;
  return { ...state, route, noiseTarget: heard, standUntil: null };
}

/**
 * Walks its route, turning it towards the clearest noise it hears; at the end of a route it
 * stands a while, then picks a new leg.
 */
function wander(
  state: Wander,
  at: Point,
  game: Session,
  config: ZombieConfig,
): Wander {
  const { map } = game.world;
  const { result: heard, seed } = listen(state, at, game);
  if (heard !== null)
    return investigate({ ...state, seed }, at, heard.at, map, config);
  if (state.route.length > 0) return state;
  const standing = { ...state, noiseTarget: null };
  if (standing.standUntil === null) return stand(standing, game, config);
  if (game.worldTime < standing.standUntil) return standing;
  const leg = withSeed(standing.seed, (rng) => wanderLeg(map, at, rng, config));
  return {
    ...standing,
    seed: leg.seed,
    route: leg.result ?? [],
    standUntil: null,
  };
}

/** Stands from now for a pause drawn from its seed. */
function stand(state: Wander, game: Session, config: ZombieConfig): Wander {
  const { result, seed } = withSeed(state.seed, (rng) =>
    pauseLength(rng, config),
  );
  return { ...state, seed, standUntil: game.worldTime + result };
}

/** What a zombie carries over from `state` on changing mode. */
function kept(state: ZombieState) {
  const { seed, barkAt, attackAt, attacking, facing } = state;
  return { seed, barkAt, attackAt, attacking, facing };
}

/** Heads for `seen`, planning anew unless the chase already heads close enough to it. */
function pursue(
  state: ZombieState,
  at: Point,
  seen: Point,
  map: TileMap,
  config: ZombieConfig,
): ZombieState {
  const { target } = state;
  if (
    target !== null &&
    state.route.length > 0 &&
    Math.hypot(target.x - seen.x, target.y - seen.y) <= config.repathDistance
  )
    return state;
  return {
    ...kept(state),
    mode: "chase",
    route: planRoute(map, config.radius, at, seen) ?? [],
    target: seen,
  };
}

/** Back to wandering, standing a while first. */
function giveUp(
  state: ZombieState,
  game: Session,
  config: ZombieConfig,
): Wander {
  return stand(
    {
      ...kept(state),
      mode: "wander",
      route: [],
      target: null,
      standUntil: null,
      noiseTarget: null,
    },
    game,
    config,
  );
}

/**
 * The state zombie `self` moves to: sighted prey starts or steers a chase, a chase that reaches
 * where its prey was last seen gives up, and otherwise it wanders, drawn by what it hears.
 */
function think(
  state: ZombieState,
  self: Prey,
  game: Session,
  config: ZombieConfig,
): ZombieState {
  const { map } = game.world;
  const seen = sighting(game, self, config.sightRange, state.facing);
  if (seen !== null) return pursue(state, self, seen, map, config);
  if (state.mode === "wander") return wander(state, self, game, config);
  return state.route.length > 0 ? state : giveUp(state, game, config);
}

/** The prey close enough to zombie `self` to be hit by its attack. */
function inReach(self: Prey, game: Session, config: ZombieConfig): Prey[] {
  return preyNear(game, self, (prey) =>
    Math.max(config.attackRange, self.radius + prey.radius + 1),
  );
}

/** Attacks once the cooldown is over, while chasing, when any prey is in reach. */
function attack(
  state: ZombieState,
  self: Prey,
  game: Session,
  config: ZombieConfig,
): ZombieState {
  const attacking =
    game.worldTime >= state.attackAt &&
    state.target !== null &&
    inReach(self, game, config).length > 0;
  if (!attacking) return { ...state, attacking };
  return {
    ...state,
    attacking,
    attackAt: game.worldTime + config.attackCooldown,
  };
}

/** Barks once its time comes, drawing when to bark next. */
function bark(
  state: ZombieState,
  game: Session,
  config: ZombieConfig,
): ZombieState {
  if (game.worldTime < state.barkAt) return state;
  const { result, seed } = withSeed(state.seed, (rng) => barkGap(rng, config));
  return {
    ...state,
    seed,
    barkAt: game.worldTime + result,
  };
}

/**
 * Sounds, as the host, on every client, what a step from `previous` to `next` did: a chase
 * started, an attack or a bark.
 */
function cue(
  entity: WorldEntity,
  previous: ZombieState,
  next: ZombieState,
  game: Session,
  sounds: Sounds,
): void {
  const made = [
    previous.mode !== "chase" && next.mode === "chase" && sounds.alert,
    next.attacking && sounds.attack,
    next.barkAt !== previous.barkAt && sounds.bark,
  ];
  for (const sound of made)
    if (sound !== false) effect(game, { at: entity, sound }, entity);
}

/** A zombie's sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly bark: Sound;
  readonly alert: Sound;
  readonly attack: Sound;
}

function definition(config: ZombieConfig): EntityDefinition<ZombieState> {
  const sounds: Sounds = {
    bark: sound({ url: barkUrl, range: config.sounds.bark }),
    alert: sound({ url: alertUrl, range: config.sounds.alert }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: ZombieState,
    update(entity, state, dt, game) {
      const thought = think(state, entity, game, config);
      const next = bark(attack(thought, entity, game, config), game, config);
      cue(entity, state, next, game, sounds);
      const speed =
        next.mode === "chase" ? config.chaseSpeed : config.wanderSpeed;
      const route = steer(entity, next.route, speed, dt);
      const facing =
        entity.vx === 0 && entity.vy === 0
          ? next.facing
          : Math.atan2(entity.vy, entity.vx);
      return { ...next, route, facing };
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return inReach(entity, game, config).map((prey) => ({
        target: prey.id,
        amount: config.attackDamage,
      }));
    },
    draw(ctx, entity, state) {
      drawEmoji(ctx, entity, ZOMBIE_GLYPH, entity.radius * 2);
      ctx.strokeStyle =
        state.mode === "wander" && state.noiseTarget !== null
          ? COLOURS.listen
          : COLOURS[state.mode];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, entity.radius + 2, 0, Math.PI * 2);
      ctx.stroke();
      drawFacing(ctx, entity, state.facing, entity.radius * 1.5);
    },
  };
}

/**
 * A zombie: wanders slowly, drawn towards what it hears but deaf to other zombies, and runs down
 * anything living it sees, zombies and inert things aside, to where it last saw it. A new world
 * scatters groups of them away from the players, each drawing its own seed, and more groups keep
 * arriving out of sight, ever faster as the world ages.
 */
export const zombie = defineEntity(NAME, (config: ZombieConfig) => ({
  ...definition(config),
  spawn: {
    at: "scatter",
    ...config.spawn,
    data: (rng: Rng, game: Session) =>
      freshZombie(Math.floor(rng() * 2 ** 32), game.worldTime, config),
    weight: spawnWeight,
  },
  world: { spawning },
  step(game: Session) {
    stepSpawning(game, NAME, config.radius, config.spawning, (at) => {
      const seed = Math.floor(Math.random() * 2 ** 32);
      spawn(game, NAME, at, freshZombie(seed, game.worldTime, config));
    });
  },
}));
