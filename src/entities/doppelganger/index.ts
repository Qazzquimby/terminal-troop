import { z } from "zod";
import { drawLikePlayer } from "../../render/index.js";
import {
  defineEntity,
  echoVoice,
  effect,
  FOOTSTEP_TAG,
  layCorpse,
  livingPlayers,
  rounded,
  sound,
  soundDrop,
  spawnWorldItem,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Eyes,
  Point,
  Rng,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { gazeOn, nearestSeenBody } from "../bodies.js";
import type { Watching } from "../bodies.js";
import {
  clearestNoise,
  NEVER_PREY,
  periodicCall,
  preyNear,
  Route,
  Seed,
  strikeEach,
  strikeIf,
  Time,
  Waypoint,
  wanderLeg,
  withSeed,
} from "../hunt.js";
import type { Prey } from "../hunt.js";
import { planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The file may not be in yet: a missing one plays nothing, but its noise is still made.
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/**
 * How a doppelganger passes for a player, hunts and speaks. Distances in pixels, speeds in pixels
 * a second, times in sim seconds.
 */
export interface DoppelgangerConfig extends Watching {
  /** How the world's spawner brings them. */
  readonly spawning: SpawningConfig;
  /** A player's, so it stands and is drawn as one. */
  readonly radius: number;
  /** A player's, so it takes as much to fell as one. */
  readonly maxHealth: number;
  /** A player's walk: it never goes faster nor slower. */
  readonly speed: number;
  /** How near a body it hunts must be for it to turn on it, as a zombie would. */
  readonly attackRange: number;
  /** How near its quarry must be to be struck. */
  readonly reach: number;
  /** Damage dealt to each body within reach as it strikes. */
  readonly damage: number;
  /** Seconds between strikes. */
  readonly attackCooldown: number;
  /** Seconds no gaze may fall on it before it heads for where it last knew a body to be. */
  readonly unwatchedSeconds: number;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds it stands looking round at the end of each wander leg. */
  readonly lookSeconds: number;
  /** How far either way, in radians, it turns its head looking round. */
  readonly lookSweep: number;
  /** How far where a body was known to be must move before it plans its approach anew. */
  readonly repathDistance: number;
  /** Seconds between barks in the voice of the player it copies, drawn between the two. */
  readonly barkGap: { readonly min: number; readonly max: number };
  /** How far a bark carries, heard and as noise. */
  readonly barkRange: number;
  /** The chance it arrives holding an item, 0..1, and the items it may hold, drawn evenly. */
  readonly holds: {
    readonly chance: number;
    readonly items: readonly string[];
  };
  /** How far each of its other sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: { readonly attack: number };
}

const NAME = "doppelganger";

/**
 * Everyone reads whom it copies, by `copies`, the name it shows, its facing and what it holds,
 * to draw it; the rest only the host reads.
 * - wander: walks `route` between random spots; at the end of each it stands looking round, its
 *   head sweeping from `lookFrom`, until `lookUntil`, then picks the next
 * - approach: heads along `route` for `known`, where it last knew a body to be
 * - attack: runs at `quarry`, striking it once in reach
 * `watchedAt` is when a gaze last fell on it; `known`, where it last saw or heard a body; `stepAt`,
 * when it next makes a footstep's noise.
 */
export const DoppelgangerState = z.object({
  mode: z.enum(["wander", "approach", "attack"]),
  copies: z.string().min(1).max(64),
  name: z.string().max(64),
  held: z.string().max(64).nullable(),
  facing: rounded(2),
  seed: Seed,
  route: Route,
  lookFrom: rounded(2),
  lookUntil: Time.nullable(),
  known: Waypoint.nullable(),
  quarry: z.string().nullable(),
  watchedAt: Time,
  barkAt: Time.nullable(),
  attackAt: Time,
  attacking: z.boolean(),
  stepAt: Time,
});

export type DoppelgangerState = z.output<typeof DoppelgangerState>;

/** Whom a new doppelganger copies: its id and the name it shows. */
interface Copied {
  readonly id: string;
  readonly name: string;
}

/**
 * A fresh doppelganger of `copied`, holding `held` if anything, its draws seeded by `seed`. Its
 * deadlines start at the world's dawn, so it starts as if long unwatched, whenever it arrives.
 */
export function freshDoppelganger(
  seed: number,
  copied: Copied,
  held: string | null = null,
): DoppelgangerState {
  return {
    mode: "wander",
    copies: copied.id,
    name: copied.name,
    held,
    facing: 0,
    seed: seed | 0,
    route: [],
    lookFrom: 0,
    lookUntil: null,
    known: null,
    quarry: null,
    watchedAt: 0,
    barkAt: null,
    attackAt: 0,
    attacking: false,
    stepAt: 0,
  };
}

/**
 * A new arrival's doppelganger, drawn from `rng`: a copy of one of the living players, holding
 * one of the items it may hold, those the world has, by its chance.
 */
function arriving(
  rng: Rng,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  const players = livingPlayers(game);
  const player =
    players[Math.floor(rng() * players.length)] ??
    game.players.get(game.localId) ??
    game.local;
  const items = config.holds.items.filter((item) =>
    game.itemDefinitions.has(item),
  );
  const holds = rng() < config.holds.chance;
  const held = holds ? (items[Math.floor(rng() * items.length)] ?? null) : null;
  return freshDoppelganger(
    Math.floor(rng() * 2 ** 32),
    { id: player.id, name: player.name },
    held,
  );
}

/** Its eyes, facing `facing`: a player's own, cone and surroundings both. */
function eyes(facing: number, game: Session): Eyes {
  const { coneAngle, surroundingsRadius, lookRange } = game.config.vision;
  return {
    cone: { direction: facing, angle: coneAngle, range: lookRange },
    around: surroundingsRadius,
  };
}

/** The bodies it may hunt within `reach` of it. */
function preyWithin(
  self: Prey,
  game: Session,
  reach: (prey: Prey) => number,
  config: DoppelgangerConfig,
): Prey[] {
  return preyNear(game, self, reach, [...config.ignores, ...NEVER_PREY]);
}

/** The nearest body it may hunt within its attack range, or null. */
function quarryNear(
  self: Prey,
  game: Session,
  config: DoppelgangerConfig,
): Prey | null {
  let best: Prey | null = null;
  let bestDistance = Infinity;
  for (const prey of preyWithin(self, game, () => config.attackRange, config)) {
    const distance = Math.hypot(prey.x - self.x, prey.y - self.y);
    if (distance < bestDistance) {
      best = prey;
      bestDistance = distance;
    }
  }
  return best;
}

/** The bodies close enough to be struck. */
function inReach(
  self: Prey,
  game: Session,
  config: DoppelgangerConfig,
): Prey[] {
  return preyWithin(
    self,
    game,
    (prey) => Math.max(config.reach, self.radius + prey.radius + 1),
    config,
  );
}

/**
 * Where it now knows a body to be: the nearest it sees, else where the clearest noise it hears
 * seemed to come from, else where it knew before. It pays its own kind's noise no mind.
 */
function learn(
  state: DoppelgangerState,
  self: WorldEntity,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  const seen = nearestSeenBody(game, self, config);
  if (seen !== null) return { ...state, known: { x: seen.x, y: seen.y } };
  const { result: heard, seed } = withSeed(state.seed, (rng) =>
    clearestNoise(game, { at: self, rng, ignores: config.ignores }),
  );
  if (heard === null) return { ...state, seed };
  return { ...state, seed, known: { x: heard.at.x, y: heard.at.y } };
}

/** Back to wandering, from where it stands. */
const wandering = (state: DoppelgangerState): DoppelgangerState => ({
  ...state,
  mode: "wander",
  route: [],
  quarry: null,
  lookUntil: null,
});

/**
 * Wanders: walks its leg; at its end stands looking round, then draws the next. A leg it cannot
 * draw leaves it looking round a while longer.
 */
function wander(
  state: DoppelgangerState,
  self: WorldEntity,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  if (state.route.length > 0) return state;
  const now = game.worldTime;
  if (state.lookUntil === null)
    return {
      ...state,
      lookUntil: now + config.lookSeconds,
      lookFrom: state.facing,
    };
  if (now < state.lookUntil) return state;
  const leg = withSeed(state.seed, (rng) =>
    wanderLeg(game.world.map, self, rng, self.radius, config.wanderRange),
  );
  if (leg.result === null) return { ...state, seed: leg.seed, lookUntil: null };
  return { ...state, seed: leg.seed, route: leg.result, lookUntil: null };
}

/** Heads for where it last knew a body to be, planning anew once that has moved far enough. */
function approach(
  state: DoppelgangerState,
  self: WorldEntity,
  known: Point,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  const last = state.route.at(-1);
  if (
    state.mode === "approach" &&
    last !== undefined &&
    Math.hypot(last.x - known.x, last.y - known.y) <= config.repathDistance
  )
    return state;
  const route = planRoute(game.world.map, self.radius, self, known);
  if (route === null || route.length === 0)
    return wander({ ...wandering(state), known: null }, self, game, config);
  return { ...state, mode: "approach", route, quarry: null, lookUntil: null };
}

/**
 * The state it moves to: a body it hunts within its attack range it runs at, as a zombie would;
 * otherwise, under a gaze it heeds, it wanders as a player exploring would; unwatched long
 * enough, it approaches where it last knew a body to be, and wanders again once there.
 */
function think(
  previous: DoppelgangerState,
  self: WorldEntity,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  const now = game.worldTime;
  const watched = gazeOn(game, self, config)(self);
  const state = learn(
    watched ? { ...previous, watchedAt: now } : previous,
    self,
    game,
    config,
  );
  const quarry = quarryNear(self, game, config);
  if (quarry !== null)
    return {
      ...state,
      mode: "attack",
      quarry: quarry.id,
      route: [{ x: quarry.x, y: quarry.y }],
      known: { x: quarry.x, y: quarry.y },
      lookUntil: null,
    };
  const settled = state.mode === "wander" ? state : wandering(state);
  if (watched || now - state.watchedAt < config.unwatchedSeconds)
    return wander(settled, self, game, config);
  const { known } = state;
  if (known === null) return wander(settled, self, game, config);
  if (Math.hypot(known.x - self.x, known.y - self.y) <= self.radius)
    return wander({ ...settled, known: null }, self, game, config);
  return approach(state, self, known, game, config);
}

/** Barks in the voice of the player it copies once due, drawing when it next does. */
function bark(
  state: DoppelgangerState,
  self: WorldEntity,
  game: Session,
  config: DoppelgangerConfig,
): DoppelgangerState {
  const call = periodicCall(
    state.barkAt,
    game.worldTime,
    state.seed,
    config.barkGap,
  );
  if (!call.calls) return { ...state, barkAt: call.at, seed: call.seed };
  const pick = withSeed(call.seed, (rng) => Math.floor(rng() * 2 ** 16));
  echoVoice(game, self, state.copies, config.barkRange, pick.result);
  return { ...state, barkAt: call.at, seed: pick.seed };
}

/** Its facing as it stands looking round: a slow sweep either side of where it faced. */
function lookingRound(
  state: DoppelgangerState,
  now: number,
  config: DoppelgangerConfig,
): number {
  if (state.lookUntil === null) return state.facing;
  const left = Math.max(0, state.lookUntil - now);
  const t = 1 - left / config.lookSeconds;
  return state.lookFrom + config.lookSweep * Math.sin(t * Math.PI * 2);
}

/** Makes a walking player's footstep noise as it moves, at a walk's pace. */
function footsteps(
  state: DoppelgangerState,
  self: WorldEntity,
  game: Session,
): DoppelgangerState {
  const now = game.worldTime;
  const moving = self.vx !== 0 || self.vy !== 0;
  if (!moving || now < state.stepAt) return state;
  const { interval, radius } = game.config.footsteps.walk;
  effect(game, { at: self, noise: radius, tags: [FOOTSTEP_TAG] }, self);
  return { ...state, stepAt: now + interval };
}

/** As the host, lays what it holds where it stands, with its drop sound. */
function dropHeld(game: Session, self: WorldEntity, item: string): void {
  if (!game.itemDefinitions.has(item)) return;
  const at = { x: self.x, y: self.y };
  spawnWorldItem(game, at, item);
  soundDrop(game, item, at, self);
}

function definition(
  config: DoppelgangerConfig,
): EntityDefinition<DoppelgangerState> {
  const attack: Sound = sound({ url: attackUrl, range: config.sounds.attack });
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    // A player's bar, where a player's shows, is drawn with it.
    healthBar: false,
    data: DoppelgangerState,
    eyes: (_entity, state, game) => eyes(state.facing, game),
    update(entity, state, dt, game) {
      const now = game.worldTime;
      let next = think(state, entity, game, config);
      next = strikeIf(
        next,
        now,
        next.mode === "attack" && inReach(entity, game, config).length > 0,
        config.attackCooldown,
      );
      if (next.attacking) effect(game, { at: entity, sound: attack }, entity);
      next = bark(next, entity, game, config);
      const route = steer(entity, next.route, config.speed, dt);
      const moving = entity.vx !== 0 || entity.vy !== 0;
      const facing = moving
        ? Math.atan2(entity.vy, entity.vx)
        : lookingRound(next, now, config);
      return footsteps({ ...next, route, facing }, entity, game);
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return strikeEach(inReach(entity, game, config), config.damage);
    },
    dies(entity, state, game) {
      if (state.held !== null) dropHeld(game, entity, state.held);
      // Brought back, it rises as a fresh copy of the same player, empty handed.
      layCorpse(game, entity, state.name, {
        kind: NAME,
        data: freshDoppelganger(state.seed, {
          id: state.copies,
          name: state.name,
        }),
      });
    },
    // Drawn as any other player is, whoever looks: the one it copies sees its own double.
    draw(ctx, entity, state, _now, game) {
      const held =
        state.held === null
          ? null
          : (game.itemDefinitions.get(state.held)?.emoji ?? null);
      drawLikePlayer(
        ctx,
        entity,
        { name: state.name, aim: state.facing, crouched: false },
        held,
      );
    },
  };
}

/**
 * The doppelganger: a copy of one of the players, drawn as that player is, name, facing and all,
 * holding an item now and then, moving at a player's walk with a player's footsteps. Under the
 * gaze of any body but its own kind it wanders as a player exploring would, looking round each
 * spot it comes to; unwatched for a while, it heads for where it last saw or heard a body. Any
 * body it hunts that comes within a few steps it runs at and strikes, as a zombie does. Every 6 to
 * 12 seconds it says something in its player's own recorded voice, which everyone hears but that
 * player. Felled, it drops what it held and leaves its player's corpse, which brought back rises
 * as the doppelganger again.
 */
export const doppelganger = defineEntity(
  NAME,
  (config: DoppelgangerConfig) => ({
    ...definition(config),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (seed: number, game: Session) =>
        withSeed(Math.floor(seed * 2 ** 32), (rng) =>
          arriving(rng, game, config),
        ).result,
    }),
  }),
);
