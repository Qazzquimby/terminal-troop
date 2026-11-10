import { z } from "zod";
import alertUrl from "../assets/sfx/zombie/alert.mp3";
import attackUrl from "../assets/sfx/zombie/attack.mp3";
import barkUrl from "../assets/sfx/zombie/bark.mp3";
import { drawFacing } from "../render/render.js";
import {
  canSeeFrom,
  directionalVision,
  isAreaFree,
  mulberry32Next,
} from "../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Rng,
  Session,
  TileMap,
} from "../sim/index.js";
import { MAX_WAYPOINTS, planRoute, steer } from "./route.js";

/** How a chaser moves and hunts. Distances are in pixels, speeds in pixels per second. */
export interface ChaserConfig {
  readonly radius: number;
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
}

const Waypoint = z.object({ x: z.number(), y: z.number() });

const Route = z.array(Waypoint).max(MAX_WAYPOINTS);

/** A mulberry32 state. */
const Seed = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);

/** The sound timers a chaser keeps whichever mode it is in. */
const SoundTimers = {
  /** Seconds until the next bark. */
  nextBark: z.number().min(0),
  /** Seconds until the chaser may attack again. */
  attackCooldown: z.number().min(0),
};

/**
 * - wander: walks `route`, then stands for `pause` seconds, then picks a new leg
 * - chase: heads along `route` for `target`, where a player was last seen
 */
export const ChaserState = z.discriminatedUnion("mode", [
  z.object({
    ...SoundTimers,
    mode: z.literal("wander"),
    seed: Seed,
    route: Route,
    pause: z.number().min(0),
    facing: z.number(),
  }),
  z.object({
    ...SoundTimers,
    mode: z.literal("chase"),
    seed: Seed,
    route: Route,
    target: Waypoint,
    facing: z.number(),
  }),
]);

export type ChaserState = z.output<typeof ChaserState>;

type Wander = Extract<ChaserState, { mode: "wander" }>;

/** Random points tried for a wander leg before standing a while longer. */
const LEG_ATTEMPTS = 8;

/** Seconds between barks; a fresh gap is drawn after each one. */
const BARK_GAP = { min: 6, max: 12 } as const;

/** How close to its target a chasing chaser must be to attack, in pixels. */
const ATTACK_RANGE = 30;

/** Seconds between attacks. */
const ATTACK_COOLDOWN = 2;

const SOUNDS = { bark: barkUrl, alert: alertUrl, attack: attackUrl } as const;

const COLOURS = { wander: "#7d9a52", chase: "#d8473a" } as const;

/** A fresh chaser's state, its random draws seeded by `seed`. */
export function freshChaser(seed: number): ChaserState {
  const { result, seed: next } = withSeed(seed | 0, barkGap);
  return {
    mode: "wander",
    seed: next,
    route: [],
    pause: 0,
    nextBark: result,
    attackCooldown: 0,
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

function barkGap(rng: Rng): number {
  return BARK_GAP.min + (BARK_GAP.max - BARK_GAP.min) * rng();
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

function wander(
  state: Wander,
  at: Point,
  dt: number,
  map: TileMap,
  config: ChaserConfig,
): Wander {
  if (state.route.length > 0) return state;
  if (state.pause > 0)
    return { ...state, pause: Math.max(0, state.pause - dt) };
  const { result, seed } = withSeed(state.seed, (rng) => ({
    route: wanderLeg(map, at, rng, config) ?? [],
    pause: pauseLength(rng, config),
  }));
  return { ...state, seed, ...result };
}

/** Heads for `seen`, planning anew unless the chase already heads close enough to it. */
function pursue(
  state: ChaserState,
  at: Point,
  seen: Point,
  map: TileMap,
  config: ChaserConfig,
): ChaserState {
  if (
    state.mode === "chase" &&
    state.route.length > 0 &&
    Math.hypot(state.target.x - seen.x, state.target.y - seen.y) <=
      config.repathDistance
  )
    return state;
  return {
    mode: "chase",
    seed: state.seed,
    route: planRoute(map, config.radius, at, seen) ?? [],
    target: seen,
    nextBark: state.nextBark,
    attackCooldown: state.attackCooldown,
    facing: state.facing,
  };
}

/** Back to wandering, standing a while first. */
function giveUp(state: ChaserState, config: ChaserConfig): Wander {
  const { result, seed } = withSeed(state.seed, (rng) =>
    pauseLength(rng, config),
  );
  return {
    mode: "wander",
    seed,
    route: [],
    pause: result,
    nextBark: state.nextBark,
    attackCooldown: state.attackCooldown,
    facing: state.facing,
  };
}

/**
 * The state a chaser at `at` moves to: a sighted player starts or steers a chase, a chase
 * that reaches where its player was last seen gives up, and otherwise it wanders.
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
  if (state.mode === "wander") return wander(state, at, dt, map, config);
  return state.route.length > 0 ? state : giveUp(state, config);
}

/**
 * Plays the chaser's cues and ticks its sound timers: it alerts as it starts a chase, barks
 * every few seconds, and attacks once it is close to where it is headed.
 */
function voice(
  previous: ChaserState,
  next: ChaserState,
  at: Point & { readonly radius: number },
  dt: number,
  game: Session,
): ChaserState {
  const listener = { x: game.local.x, y: game.local.y };
  const play = (url: string): void => {
    void game.sfx.play(url, at, listener);
  };

  if (previous.mode !== "chase" && next.mode === "chase") play(SOUNDS.alert);

  const attackRange = Math.max(
    ATTACK_RANGE,
    at.radius + game.config.player.radius + 1,
  );
  let attackCooldown = Math.max(0, next.attackCooldown - dt);
  if (
    attackCooldown === 0 &&
    next.mode === "chase" &&
    Math.hypot(next.target.x - at.x, next.target.y - at.y) <= attackRange
  ) {
    play(SOUNDS.attack);
    // doesnt actually attack yet
    attackCooldown = ATTACK_COOLDOWN;
  }

  let { seed, nextBark } = next;
  nextBark -= dt;
  if (nextBark <= 0) {
    play(SOUNDS.bark);
    const drawn = withSeed(seed, barkGap);
    seed = drawn.seed;
    nextBark = drawn.result;
  }

  return { ...next, seed, nextBark, attackCooldown };
}

/** A chaser: wanders slowly, and runs down any player it sees to where it last saw them. */
export function chaser(config: ChaserConfig): EntityDefinition<ChaserState> {
  return {
    radius: config.radius,
    data: ChaserState,
    update(entity, state, dt, game) {
      const thought = think(state, entity, dt, game, config);
      const next = voice(state, thought, entity, dt, game);
      const speed =
        next.mode === "chase" ? config.chaseSpeed : config.wanderSpeed;
      const route = steer(entity, next.route, speed, dt);
      const facing =
        entity.vx === 0 && entity.vy === 0
          ? next.facing
          : Math.atan2(entity.vy, entity.vx);
      return { ...next, route, facing };
    },
    draw(ctx, entity, state) {
      ctx.fillStyle = COLOURS[state.mode];
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, entity.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#1a1d12";
      ctx.lineWidth = 3;
      ctx.stroke();
      drawFacing(ctx, entity, state.facing, entity.radius * 1.5);
    },
  };
}
