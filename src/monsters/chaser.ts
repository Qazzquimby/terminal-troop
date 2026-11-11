import { z } from "zod";
import alertUrl from "./sfx/alert.mp3";
import attackUrl from "./sfx/attack.mp3";
import barkUrl from "./sfx/bark.mp3";
import { drawEmoji, drawFacing } from "../render/index.js";
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
  Strike,
  TileMap,
} from "../sim/index.js";
import { MAX_WAYPOINTS, planRoute, steer } from "./route.js";

/** How a chaser moves and hunts. Distances are in pixels, speeds in pixels per second. */
export interface ChaserConfig {
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
}

const Waypoint = z.object({ x: z.number(), y: z.number() });

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
  nextBark: z.number().min(0),
  /** Seconds until the chaser may attack again. */
  attackCooldown: z.number().min(0),
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
  facing: z.number(),
};

/**
 * - wander: walks `route`, then stands for `pause` seconds, then picks a new leg
 * - chase: heads along `route` for `target`, where a player was last seen
 */
export const ChaserState = z.discriminatedUnion("mode", [
  z.object({ ...Shared, mode: z.literal("wander"), pause: z.number().min(0) }),
  z.object({ ...Shared, mode: z.literal("chase") }),
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

const CHASER_GLYPH = "🧟";

/** A fresh chaser's state, its random draws seeded by `seed`. */
export function freshChaser(seed: number): ChaserState {
  const { result, seed: next } = withSeed(seed | 0, barkGap);
  return {
    mode: "wander",
    seed: next,
    route: [],
    target: null,
    pause: 0,
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

/** How close a player must be to a chaser of `radius` to be hit by its attack. */
function attackRange(radius: number, game: Session): number {
  return Math.max(ATTACK_RANGE, radius + game.config.player.radius + 1);
}

/** Ticks the attack cooldown, and attacks once the chaser is close to where it is headed. */
function attack(
  state: ChaserState,
  at: Point & { readonly radius: number },
  dt: number,
  game: Session,
): ChaserState {
  const attackCooldown = Math.max(0, state.attackCooldown - dt);
  const { target } = state;
  const attacking =
    attackCooldown === 0 &&
    target !== null &&
    Math.hypot(target.x - at.x, target.y - at.y) <=
      attackRange(at.radius, game);
  if (!attacking) return { ...state, attacking, attackCooldown };
  return {
    ...state,
    attacking,
    attackCooldown: ATTACK_COOLDOWN,
    attacks: state.attacks + 1,
  };
}

/** Ticks the bark timer, barking and drawing a fresh gap once it runs out. */
function bark(state: ChaserState, dt: number): ChaserState {
  const nextBark = state.nextBark - dt;
  if (nextBark > 0) return { ...state, nextBark };
  const { result, seed } = withSeed(state.seed, barkGap);
  return { ...state, seed, nextBark: result, barks: state.barks + 1 };
}

/** A chaser: wanders slowly, and runs down any player it sees to where it last saw them. */
export function chaser(config: ChaserConfig): EntityDefinition<ChaserState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: ChaserState,
    update(entity, state, dt, game) {
      const thought = think(state, entity, dt, game, config);
      const next = bark(attack(thought, entity, dt, game), dt);
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
      const range = attackRange(entity.radius, game);
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
      ctx.strokeStyle = COLOURS[state.mode];
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(entity.x, entity.y, entity.radius + 2, 0, Math.PI * 2);
      ctx.stroke();
      drawFacing(ctx, entity, state.facing, entity.radius * 1.5);
    },
  };
}
