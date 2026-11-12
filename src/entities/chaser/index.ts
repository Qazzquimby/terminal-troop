import { z } from "zod";
import alertUrl from "./sfx/alert.mp3";
import attackUrl from "./sfx/attack.mp3";
import barkUrl from "./sfx/bark.mp3";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  canSeeFrom,
  defineEntity,
  directionalVision,
  isAreaFree,
  mulberry32Next,
  noisesHeardBy,
  rounded,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Heard,
  Point,
  Rng,
  Scatter,
  Session,
  Strike,
  TileMap,
} from "../../sim/index.js";
import { MAX_WAYPOINTS, planRoute, steer } from "../route.js";

/**
 * How a chaser moves and hunts, and how many a new world starts with. Distances are in pixels,
 * speeds in pixels per second.
 */
export interface ChaserConfig {
  readonly spawn: Scatter;
  readonly radius: number;
  /** Health when at full. */
  readonly maxHealth: number;
  /** Damage dealt to each player within attack range. */
  readonly attackDamage: number;
  readonly wanderSpeed: number;
  readonly chaseSpeed: number;
  /** How far a chaser sees a player it has a clear line to within its sight cone. */
  readonly sightRange: number;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds a chaser stands after a wander leg or a lost chase, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** How far a sighted player must be from where the chase is headed before it plans anew. */
  readonly repathDistance: number;
  /** Seconds between barks, drawn between the two after each one. */
  readonly barkGap: { readonly min: number; readonly max: number };
  /** How close to its target a chasing chaser must be to attack. */
  readonly attackRange: number;
  /** Seconds between attacks. */
  readonly attackCooldown: number;
  /** How far a chaser hears a noise of loudness 1. */
  readonly hearingRange: number;
}

/** A point, sent to a tenth of a pixel. */
const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** Seconds, sent to a hundredth. */
const Seconds = rounded(2, z.number().min(0));

const Route = z.array(Waypoint).max(MAX_WAYPOINTS);

/** A mulberry32 state. */
const Seed = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);

const Count = z.number().int().min(0);

/** What a chaser keeps whichever mode it is in. */
const Shared = {
  /** Seconds until the next bark. */
  nextBark: Seconds,
  /** Seconds until the chaser may attack again. */
  attackCooldown: Seconds,
  /** Whether it attacks in this step. */
  attacking: z.boolean(),
  /** Counts of barks, chases started and attacks, so every client hears each one. */
  barks: Count,
  alerts: Count,
  attacks: Count,
  seed: Seed,
  route: Route,
  /** Where a chase is headed, or null while wandering. */
  target: Waypoint.nullable(),
  /** Radians, sent to a hundredth. */
  facing: rounded(2),
};

/**
 * - wander: walks `route`, then stands for `pause` seconds, then picks a new leg; a heard
 *   noise turns its route towards `noiseTarget`, where the noise seemed to come from
 * - chase: heads along `route` for `target`, where a player was last seen
 */
export const ChaserState = z.discriminatedUnion("mode", [
  z.object({
    ...Shared,
    mode: z.literal("wander"),
    pause: Seconds,
    noiseTarget: Waypoint.nullable(),
  }),
  z.object({ ...Shared, mode: z.literal("chase") }),
]);

export type ChaserState = z.output<typeof ChaserState>;

type Wander = Extract<ChaserState, { mode: "wander" }>;

/** Random points tried for a wander leg before standing a while longer. */
const LEG_ATTEMPTS = 8;

const SOUNDS = { bark: barkUrl, alert: alertUrl, attack: attackUrl } as const;

const COLOURS = {
  wander: "#7d9a52",
  listen: "#d8a13a",
  chase: "#d8473a",
} as const;

const CHASER_GLYPH = "🧟";

/** A fresh chaser's state, its random draws seeded by `seed`. */
export function freshChaser(seed: number, config: ChaserConfig): ChaserState {
  const { result, seed: next } = withSeed(seed | 0, (rng) =>
    barkGap(rng, config),
  );
  return {
    mode: "wander",
    seed: next,
    route: [],
    target: null,
    pause: 0,
    noiseTarget: null,
    nextBark: result,
    attackCooldown: 0,
    attacking: false,
    barks: 0,
    alerts: 0,
    attacks: 0,
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

/** The nearest player a chaser at `at` sees within its cone or surroundings, or null. */
function sighting(
  game: Session,
  at: Point,
  range: number,
  facing: number,
): Point | null {
  const sources = directionalVision(at, facing, game.config.vision, range);
  let nearest: Point | null = null;
  let nearestDistance = Infinity;
  for (const player of game.players.values()) {
    const distance = Math.hypot(player.x - at.x, player.y - at.y);
    if (
      distance < nearestDistance &&
      sources.some((source) => canSeeFrom(game.world.map, source, player))
    ) {
      nearest = { x: player.x, y: player.y };
      nearestDistance = distance;
    }
  }
  return nearest;
}

function pauseLength(rng: Rng, config: ChaserConfig): number {
  const { min, max } = config.wanderPause;
  return min + (max - min) * rng();
}

function barkGap(rng: Rng, config: ChaserConfig): number {
  const { min, max } = config.barkGap;
  return min + (max - min) * rng();
}

/** A route to a random free point within the wander range, or null when none of the tries finds one. */
function wanderLeg(
  map: TileMap,
  at: Point,
  rng: Rng,
  config: ChaserConfig,
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

/** The clearest noise a chaser at `at` hears this step, or null, and its seed after listening. */
function listen(
  state: Wander,
  at: Point,
  game: Session,
  config: ChaserConfig,
): { result: Heard | null; seed: number } {
  return withSeed(state.seed, (rng) => {
    let clearest: Heard | null = null;
    for (const heard of noisesHeardBy(game, {
      at,
      range: config.hearingRange,
      rng,
    })) {
      if (clearest === null || heard.clarity > clearest.clarity)
        clearest = heard;
    }
    return clearest;
  });
}

/**
 * Heads for `heard`, planning anew unless the route already heads close enough to it. A noise
 * no route reaches is ignored.
 */
function investigate(
  state: Wander,
  at: Point,
  heard: Point,
  map: TileMap,
  config: ChaserConfig,
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
  return { ...state, route, noiseTarget: heard };
}

/**
 * Walks its route, turning it towards the clearest noise it hears; at the end of a route it
 * stands, then picks a new leg.
 */
function wander(
  state: Wander,
  at: Point,
  dt: number,
  game: Session,
  config: ChaserConfig,
): Wander {
  const { map } = game.world;
  const { result: heard, seed } = listen(state, at, game, config);
  if (heard !== null)
    return investigate({ ...state, seed }, at, heard.at, map, config);
  if (state.route.length > 0) return state;
  const standing = { ...state, noiseTarget: null };
  if (standing.pause > 0)
    return { ...standing, pause: Math.max(0, standing.pause - dt) };
  const leg = withSeed(standing.seed, (rng) => ({
    route: wanderLeg(map, at, rng, config) ?? [],
    pause: pauseLength(rng, config),
  }));
  return { ...standing, seed: leg.seed, ...leg.result };
}

/** What a chaser carries over from `state` on changing mode. */
function kept(state: ChaserState) {
  const {
    seed,
    nextBark,
    attackCooldown,
    attacking,
    barks,
    alerts,
    attacks,
    facing,
  } = state;
  return {
    seed,
    nextBark,
    attackCooldown,
    attacking,
    barks,
    alerts,
    attacks,
    facing,
  };
}

/** Heads for `seen`, planning anew unless the chase already heads close enough to it. */
function pursue(
  state: ChaserState,
  at: Point,
  seen: Point,
  map: TileMap,
  config: ChaserConfig,
): ChaserState {
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
    alerts: state.mode === "chase" ? state.alerts : state.alerts + 1,
  };
}

/** Back to wandering, standing a while first. */
function giveUp(state: ChaserState, config: ChaserConfig): Wander {
  const { result, seed } = withSeed(state.seed, (rng) =>
    pauseLength(rng, config),
  );
  return {
    ...kept(state),
    mode: "wander",
    seed,
    route: [],
    target: null,
    pause: result,
    noiseTarget: null,
  };
}

/**
 * The state a chaser at `at` moves to: a sighted player starts or steers a chase, a chase
 * that reaches where its player was last seen gives up, and otherwise it wanders, drawn by
 * what it hears.
 */
function think(
  state: ChaserState,
  at: Point,
  dt: number,
  game: Session,
  config: ChaserConfig,
): ChaserState {
  const { map } = game.world;
  const seen = sighting(game, at, config.sightRange, state.facing);
  if (seen !== null) return pursue(state, at, seen, map, config);
  if (state.mode === "wander") return wander(state, at, dt, game, config);
  return state.route.length > 0 ? state : giveUp(state, config);
}

/** How close a player must be to a chaser of `radius` to be hit by its attack. */
function attackRange(
  radius: number,
  game: Session,
  config: ChaserConfig,
): number {
  return Math.max(config.attackRange, radius + game.config.player.radius + 1);
}

/** Ticks the attack cooldown, and attacks once the chaser is close to where it is headed. */
function attack(
  state: ChaserState,
  at: Point & { readonly radius: number },
  dt: number,
  game: Session,
  config: ChaserConfig,
): ChaserState {
  const attackCooldown = Math.max(0, state.attackCooldown - dt);
  const { target } = state;
  const attacking =
    attackCooldown === 0 &&
    target !== null &&
    Math.hypot(target.x - at.x, target.y - at.y) <=
      attackRange(at.radius, game, config);
  if (!attacking) return { ...state, attacking, attackCooldown };
  return {
    ...state,
    attacking,
    attackCooldown: config.attackCooldown,
    attacks: state.attacks + 1,
  };
}

/** Ticks the bark timer, barking and drawing a fresh gap once it runs out. */
function bark(
  state: ChaserState,
  dt: number,
  config: ChaserConfig,
): ChaserState {
  const nextBark = state.nextBark - dt;
  if (nextBark > 0) return { ...state, nextBark };
  const { result, seed } = withSeed(state.seed, (rng) => barkGap(rng, config));
  return { ...state, seed, nextBark: result, barks: state.barks + 1 };
}

function definition(config: ChaserConfig): EntityDefinition<ChaserState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: ChaserState,
    update(entity, state, dt, game) {
      const thought = think(state, entity, dt, game, config);
      const next = bark(attack(thought, entity, dt, game, config), dt, config);
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
      const range = attackRange(entity.radius, game, config);
      return [...game.players.values()]
        .filter(
          (player) =>
            Math.hypot(player.x - entity.x, player.y - entity.y) <= range,
        )
        .map((player) => ({ target: player.id, amount: config.attackDamage }));
    },
    cue(entity, previous, next, game) {
      const play = (url: string): void => {
        void game.sfx.play(url, entity, game.local);
      };
      if (next.alerts > previous.alerts) play(SOUNDS.alert);
      if (next.attacks > previous.attacks) play(SOUNDS.attack);
      if (next.barks > previous.barks) play(SOUNDS.bark);
    },

    draw(ctx, entity, state) {
      drawEmoji(ctx, entity, CHASER_GLYPH, entity.radius * 2);
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
 * A chaser: wanders slowly, drawn towards what it hears, and runs down any player it sees to
 * where it last saw them. A new world scatters them away from the players, each drawing its own
 * seed.
 */
export const chaser = defineEntity("chaser", (config: ChaserConfig) => ({
  ...definition(config),
  spawn: {
    at: "scatter",
    ...config.spawn,
    data: (rng: Rng) => freshChaser(Math.floor(rng() * 2 ** 32), config),
  },
}));
