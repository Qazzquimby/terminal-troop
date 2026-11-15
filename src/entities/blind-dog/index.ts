import { z } from "zod";
import {
  defineEntity,
  effect,
  hasKindTag,
  isAreaFree,
  livingBody,
  noisesHeardBy,
  rounded,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  TileMap,
  WorldEntity,
} from "../../sim/index.js";
import {
  between,
  strikeEach,
  walk,
  NEVER_PREY,
  preyNear,
  Route,
  Seed,
  Time,
  Waypoint,
  wanderLeg,
  withSeed,
} from "../hunt.js";
import type { Hunting, Prey } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const roarUrl = new URL("./sfx/roar.mp3", import.meta.url).href;
const snarlUrl = new URL("./sfx/snarl.mp3", import.meta.url).href;
const biteUrl = new URL("./sfx/bite.mp3", import.meta.url).href;
const huffUrl = new URL("./sfx/huff.mp3", import.meta.url).href;

/**
 * How a blind dog roams, listens and charges, and how often they come. Distances are in pixels,
 * speeds in pixels per second, times in seconds.
 */
export interface BlindDogConfig extends Hunting {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Damage dealt to each body it touches, at most once a cooldown. */
  readonly contactDamage: number;
  readonly contactCooldown: number;
  readonly wanderSpeed: number;
  /** How fast it walks to a noise it heard. */
  readonly stalkSpeed: number;
  /** How fast it runs once its suspicion is full. */
  readonly chargeSpeed: number;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds it stands after a wander leg, a noise followed up or a charge, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** How far a new noise must seem to be from the one it heads for before it plans anew. */
  readonly repathDistance: number;
  /**
   * Each noise it hears adds its loudness where it stands to its suspicion, which ebbs by `decay`
   * a second; at `max` it charges.
   */
  readonly suspicion: { readonly max: number; readonly decay: number };
  /** How far past the last noise it heard a charge runs. */
  readonly overrun: number;
  /**
   * Within this gap, edge to edge, of the body that made a noise it hears, it goes straight for
   * that body rather than where the noise seemed to come from, so it closes and bites.
   */
  readonly lunge: number;
  /**
   * Seconds it keeps after one noise maker within `overrun` of where it is heard, biting nothing,
   * before it gives up on it: something it cannot bite, or cannot reach.
   */
  readonly patience: number;
  /** Seconds it then stays deaf to what made that noise. */
  readonly boredSeconds: number;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly roar: number;
    readonly snarl: number;
    readonly bite: number;
    /** The huff as it gives up on a noise. */
    readonly huff: number;
  };
}

/**
 * A blind dog's state. Each field says who reads it: everyone, to draw it, or only the host, which
 * sends it so that whoever hosts next goes on from it. Its sounds reach every client as effects.
 * - wander: walks `route`, then stands until `standUntil` (host), then picks a new leg
 * - stalk: walks `route` to `heard`, where the last noise it heard seemed to come from
 * - charge: runs `route` past `heard`, then stands, its suspicion spent
 * `source` is what made the last noise it turned to, and `camped` how long it has kept near that
 * maker's noise biting nothing; given up on, the maker goes in `bored` for a while.
 */
export const BlindDogState = z.object({
  /** Everyone, to colour it. */
  mode: z.enum(["wander", "stalk", "charge"]),
  /** Host. */
  seed: Seed,
  /** Host. */
  route: Route,
  /** Host. */
  standUntil: Time.nullable(),
  /** Host. */
  heard: Waypoint.nullable(),
  /** Its suspicion as of `suspectedAt`, ebbing from then. Host. */
  suspicion: rounded(0),
  /** Host. */
  suspectedAt: Time,
  /** When it may next bite. Host. */
  biteAt: Time,
  /** Whether it bites in this step. Host. */
  biting: z.boolean(),
  /** The id of what made the noise it follows; null for none, or a noise no one made. Host. */
  source: z.string().max(64).nullable(),
  /** Seconds it has kept near the noise it follows, biting nothing. Host. */
  camped: rounded(2),
  /** What it gave up on and pays no mind to, and until when. Host. */
  bored: z.object({ id: z.string().max(64), until: Time }).nullable(),
  /** Radians, sent to a hundredth. Everyone. */
  facing: rounded(2),
});

export type BlindDogState = z.output<typeof BlindDogState>;

type Mode = BlindDogState["mode"];

/** The kind's name. */
const NAME = "blindDog";

/** It pays no mind to its own kind's noise. */
const DEAF_TO = [NAME];

/** A fresh blindDog's state at world time `now`, its random draws seeded by `seed`. */
export function freshBlindDog(seed: number, now: number): BlindDogState {
  return {
    mode: "wander",
    seed: seed | 0,
    route: [],
    standUntil: now,
    heard: null,
    suspicion: 0,
    suspectedAt: now,
    biteAt: now,
    biting: false,
    source: null,
    camped: 0,
    bored: null,
    facing: 0,
  };
}

/** Its suspicion at world time `now`, ebbed since it was last raised. */
export function suspicionAt(
  state: BlindDogState,
  now: number,
  config: BlindDogConfig,
): number {
  const ebbed = config.suspicion.decay * (now - state.suspectedAt);
  return Math.max(0, state.suspicion - ebbed);
}

/**
 * What it heard in a step: how loud it all was together, where the loudest seemed to be, and what
 * made it.
 */
interface Earful {
  readonly total: number;
  readonly at: Point | null;
  readonly source: string | null;
}

/** Whether it pays no mind, at world time `now`, to noise made by `source`. */
function boredOf(
  state: BlindDogState,
  source: string | null,
  now: number,
): boolean {
  const { bored } = state;
  return bored !== null && source === bored.id && now < bored.until;
}

/**
 * Every noise that reaches it this step but its own kind's and that of what it gave up on, and
 * its seed after listening.
 */
function listen(
  state: BlindDogState,
  at: Point,
  game: Session,
): { result: Earful; seed: number } {
  return withSeed(state.seed, (rng) => {
    let total = 0;
    let loudest = -Infinity;
    let from: Point | null = null;
    let source: string | null = null;
    for (const heard of noisesHeardBy(game, { at, rng, ignores: DEAF_TO })) {
      if (boredOf(state, heard.source, game.worldTime)) continue;
      total += Math.max(0, heard.loudness);
      if (heard.loudness < loudest) continue;
      loudest = heard.loudness;
      from = heard.at;
      source = heard.source;
    }
    return { total, at: from, source };
  });
}

/**
 * Where a charge from `from` through `noise` ends: `overrun` on past it, short of the first spot
 * a body of half-size `half` no longer fits.
 */
export function chargeEnd(
  map: TileMap,
  half: number,
  from: Point,
  noise: Point,
  overrun: number,
): Point {
  const dx = noise.x - from.x;
  const dy = noise.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return noise;
  const step = map.cell / 4;
  let end = noise;
  for (let run = step; run <= overrun; run += step) {
    const at = {
      x: noise.x + (dx / length) * run,
      y: noise.y + (dy / length) * run,
    };
    if (!isAreaFree(map, at.x, at.y, half)) break;
    end = at;
  }
  return end;
}

/**
 * Turns to a noise heard from `noise`: its suspicion rises by how loud it was, and it walks there,
 * or, suspicion full or already charging, runs at and past it. It keeps its route while that
 * already heads near enough the noise.
 */
function react(
  state: BlindDogState,
  at: Point,
  earful: Earful & { readonly at: Point },
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const now = game.worldTime;
  const { max } = config.suspicion;
  const suspicion = Math.min(
    max,
    suspicionAt(state, now, config) + earful.total,
  );
  const mode: Mode =
    state.mode === "charge" || suspicion >= max ? "charge" : "stalk";
  const { source } = earful;
  const camped = source === state.source ? state.camped : 0;
  const raised = {
    ...state,
    suspicion,
    suspectedAt: now,
    standUntil: null,
    source,
    camped,
  };
  const noise = earful.at;
  const { heard } = state;
  if (
    state.mode === mode &&
    state.route.length > 0 &&
    heard !== null &&
    Math.hypot(heard.x - noise.x, heard.y - noise.y) <= config.repathDistance
  )
    return raised;
  const { map } = game.world;
  const goal =
    mode === "charge"
      ? chargeEnd(map, config.radius, at, noise, config.overrun)
      : noise;
  const route =
    planRoute(map, config.radius, at, goal) ??
    planRoute(map, config.radius, at, noise);
  if (route === null && mode === "stalk") return raised;
  return { ...raised, mode, heard: noise, route: route ?? [] };
}

/** Stands a while from now, a pause drawn from its seed, wandering once it is over. */
function stand(
  state: BlindDogState,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const { result, seed } = withSeed(state.seed, (rng) =>
    between(rng, config.wanderPause),
  );
  return { ...state, seed, standUntil: game.worldTime + result };
}

/** Back to wandering once a noise is followed up, its suspicion spent if it charged. */
function settle(
  state: BlindDogState,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const spent =
    state.mode === "charge"
      ? { suspicion: 0, suspectedAt: game.worldTime }
      : {};
  const settled = { ...state, ...spent, mode: "wander" as const, heard: null };
  return stand({ ...settled, route: [] }, game, config);
}

/**
 * Goes straight for the body that made the noise it follows, when that is a living body it bites
 * within `lunge` of it, edge to edge, so it closes on it rather than stopping where it seemed to be.
 */
function lunge(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const maker = livingBody(game, state.source);
  if (maker === null || maker.id === self.id) return state;
  if (hasKindTag(game, maker.id, [...config.ignores, ...NEVER_PREY]))
    return state;
  const gap =
    Math.hypot(maker.x - self.x, maker.y - self.y) - self.radius - maker.radius;
  if (gap > config.lunge) return state;
  return { ...state, route: [{ x: maker.x, y: maker.y }] };
}

/**
 * Counts the time it keeps within `overrun` of the noise it follows, and once that passes its
 * patience, gives up on what made it: it settles, its suspicion spent, deaf to it a while.
 */
function tire(
  state: BlindDogState,
  self: Point,
  dt: number,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const { heard } = state;
  if (state.mode === "wander" || heard === null) return state;
  const near = Math.hypot(heard.x - self.x, heard.y - self.y) <= config.overrun;
  if (!near) return state;
  const camped = state.camped + dt;
  if (camped < config.patience) return { ...state, camped };
  const now = game.worldTime;
  const bored =
    state.source === null
      ? state.bored
      : { id: state.source, until: now + config.boredSeconds };
  const spent = { ...state, suspicion: 0, suspectedAt: now, bored };
  return settle({ ...spent, source: null, camped: 0 }, game, config);
}

/** Walks its leg, stands a while once it ends, then picks another. */
function roam(
  state: BlindDogState,
  at: Point,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  if (state.route.length > 0) return state;
  if (state.standUntil === null) return stand(state, game, config);
  if (game.worldTime < state.standUntil) return state;
  const leg = withSeed(state.seed, (rng) =>
    wanderLeg(game.world.map, at, rng, config.radius, config.wanderRange),
  );
  return {
    ...state,
    seed: leg.seed,
    route: leg.result ?? [],
    standUntil: null,
  };
}

/**
 * What it does next: turns to what it hears, going straight for its maker once close, else goes
 * on, settles, or roams.
 */
function think(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const { result: earful, seed } = listen(state, self, game);
  const listened = { ...state, seed };
  const { at } = earful;
  if (at !== null)
    return lunge(
      react(listened, self, { ...earful, at }, game, config),
      self,
      game,
      config,
    );
  if (listened.mode === "wander") return roam(listened, self, game, config);
  if (listened.route.length > 0) return listened;
  return settle(listened, game, config);
}

/** The bodies it touches and bites: any but the kinds it ignores, and what is not alive. */
function touching(self: Prey, game: Session, config: BlindDogConfig): Prey[] {
  return preyNear(game, self, (prey) => self.radius + prey.radius + 2, [
    ...config.ignores,
    ...NEVER_PREY,
  ]);
}

/** Bites once its cooldown is over, when it touches anything it bites. */
function bite(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const now = game.worldTime;
  const biting = now >= state.biteAt && touching(self, game, config).length > 0;
  return biting
    ? { ...state, biting, biteAt: now + config.contactCooldown, camped: 0 }
    : { ...state, biting };
}

/** A blind dog's sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly roar: Sound;
  readonly snarl: Sound;
  readonly bite: Sound;
  readonly huff: Sound;
}

/** Sounds, as the host, on every client, what a step from `previous` to `next` did. */
function cue(
  entity: WorldEntity,
  previous: BlindDogState,
  next: BlindDogState,
  game: Session,
  sounds: Sounds,
): void {
  const made = [
    previous.mode !== "charge" && next.mode === "charge" && sounds.roar,
    previous.mode === "wander" && next.mode === "stalk" && sounds.snarl,
    next.biting && sounds.bite,
    next.bored !== null &&
      next.bored.until !== previous.bored?.until &&
      sounds.huff,
  ];
  for (const sound of made)
    if (sound !== false) effect(game, { at: entity, sound }, entity);
}

const SPEEDS = {
  wander: "wanderSpeed",
  stalk: "stalkSpeed",
  charge: "chargeSpeed",
} as const satisfies Record<Mode, keyof BlindDogConfig>;

const LOOK = {
  body: "#2a2523",
  hide: "#4a403a",
  maw: "#6e1414",
  teeth: "#e9e2d0",
  ring: { wander: "#5c5048", stalk: "#d8a13a", charge: "#d8473a" },
} as const;

/** A heavy dark body, no eyes, a gaping red maw the way it faces, ringed by its mood. */
function drawBlindDog(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: BlindDogState,
): void {
  const { x, y, radius } = entity;
  const { facing } = state;
  ctx.save();
  ctx.fillStyle = LOOK.body;
  ctx.strokeStyle = LOOK.ring[state.mode];
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = LOOK.hide;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(
      x - Math.cos(facing + side * 0.6) * radius * 0.45,
      y - Math.sin(facing + side * 0.6) * radius * 0.45,
      radius * 0.25,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  const gape = state.mode === "charge" ? 0.75 : 0.45;
  ctx.fillStyle = LOOK.maw;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, radius * 0.9, facing - gape, facing + gape);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = LOOK.teeth;
  for (let tooth = -2; tooth <= 2; tooth++) {
    const angle = facing + (tooth / 2.5) * gape;
    const tip = radius * 0.55;
    ctx.beginPath();
    ctx.moveTo(
      x + Math.cos(angle) * radius * 0.88,
      y + Math.sin(angle) * radius * 0.88,
    );
    ctx.lineTo(
      x + Math.cos(angle + 0.06) * tip,
      y + Math.sin(angle + 0.06) * tip,
    );
    ctx.lineTo(
      x + Math.cos(angle - 0.06) * tip,
      y + Math.sin(angle - 0.06) * tip,
    );
    ctx.fill();
  }
  ctx.restore();
}

function definition(config: BlindDogConfig): EntityDefinition<BlindDogState> {
  const sounds: Sounds = {
    roar: sound({ url: roarUrl, range: config.sounds.roar }),
    snarl: sound({ url: snarlUrl, range: config.sounds.snarl }),
    bite: sound({ url: biteUrl, range: config.sounds.bite }),
    huff: sound({ url: huffUrl, range: config.sounds.huff }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: BlindDogState,
    update(entity, state, dt, game) {
      const next = bite(
        tire(think(state, entity, game, config), entity, dt, game, config),
        entity,
        game,
        config,
      );
      cue(entity, state, next, game, sounds);
      const speed = config[SPEEDS[next.mode]];
      return walk(entity, next, speed, dt);
    },
    strikes(entity, state, game): Strike[] {
      if (!state.biting) return [];
      return strikeEach(touching(entity, game, config), config.contactDamage);
    },
    draw(ctx, entity, state) {
      drawBlindDog(ctx, entity, state);
    },
  };
}

/**
 * A blind dog: a hound three cells across, deaf to its own kind. It roams slowly, walks to
 * what it hears and grows suspicious by how loud it was; once suspicion is full it roars and
 * charges through where the last noise came from and on past it, steering for each new noise as
 * it runs. Anything it touches it bites hard. Light does not keep it away: it may appear outdoors
 * too, though only far from every player.
 */
export const blindDog = defineEntity(NAME, (config: BlindDogConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    // It comes out in the light as well as the dark.
    rules: { inLight: true },
    fresh: (seed: number, game: Session) =>
      freshBlindDog(Math.floor(seed * 2 ** 32), game.worldTime),
  }),
}));
