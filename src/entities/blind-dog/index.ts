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
  Dormancy,
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
  periodicCall,
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
const roarUrl = new URL("./sfx/roar.ogg", import.meta.url).href;
const snarlUrl = new URL("./sfx/growl.ogg", import.meta.url).href;
const biteUrl = new URL("./sfx/bite.wav", import.meta.url).href;
const huffUrl = new URL("./sfx/huff.mp3", import.meta.url).href;
const growlUrl = new URL("./sfx/growl.mp3", import.meta.url).href;
const pounceUrl = new URL("./sfx/lunge.wav", import.meta.url).href;
const skidUrl = new URL("./sfx/skid.mp3", import.meta.url).href;
const barkUrl = new URL("./sfx/breathe.wav", import.meta.url).href;

/**
 * How it pounces once it commits: a crouch, a straight dash through its target and on past it that
 * it does not steer, biting each body on the line once, then a skid.
 */
interface PounceConfig {
  /** Furthest its target may be, centre to centre, for it to pounce from where it stands. */
  readonly reach: number;
  /** Seconds it crouches, growling, before it leaps. */
  readonly windup: number;
  /** How fast it dashes. */
  readonly speed: number;
  /** Seconds it skids and finds its feet after. */
  readonly recover: number;
  /** How far it slides as it skids, when nothing is in the way. */
  readonly skid: number;
}

/**
 * How a blind dog roams, listens and charges, and how often they come. Distances are in pixels,
 * speeds in pixels per second, times in seconds.
 */
export interface BlindDogConfig extends Hunting, Dormancy {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Damage dealt to each body it touches, at most once a cooldown. */
  readonly contactDamage: number;
  readonly contactCooldown: number;
  readonly wanderSpeed: number;
  /** How fast it walks to a noise it heard. */
  readonly stalkSpeed: number;
  /** How fast it runs, once its suspicion is full, until it is near enough to pounce. */
  readonly chargeSpeed: number;
  readonly pounce: PounceConfig;
  /** Furthest a wander leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds it stands after a wander leg, a noise followed up or a charge, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** Seconds between its barks, drawn between the two after each; the first a gap after it arrives. */
  readonly barkGap: { readonly min: number; readonly max: number };
  /** How far a new noise must seem to be from the one it heads for before it plans anew. */
  readonly repathDistance: number;
  /**
   * Each noise it hears adds its loudness where it stands to its suspicion, which ebbs by `decay`
   * a second; at `max` it charges.
   */
  readonly suspicion: { readonly max: number; readonly decay: number };
  /** How far past its target a pounce runs. */
  readonly overrun: number;
  /**
   * Within this gap, edge to edge, of the body that made a noise it hears, it pounces at that
   * body rather than where the noise seemed to come from, or goes straight for it when it cannot.
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
    /** The growl as it crouches to pounce. */
    readonly growl: number;
    /** The roar as it leaps. */
    readonly pounce: number;
    /** The scrabble of claws as it skids. */
    readonly skid: number;
    /** The bark it gives now and then while it roams or stalks. */
    readonly bark: number;
  };
}

/**
 * A blind dog's state. Each field says who reads it: everyone, to draw it, or only the host, which
 * sends it so that whoever hosts next goes on from it. Its sounds reach every client as effects.
 * - wander: walks `route`, then stands until `standUntil` (host), then picks a new leg
 * - stalk: walks `route` to `heard`, where the last noise it heard seemed to come from
 * - charge: runs `route` to `heard` until it is near enough to pounce
 * - crouch: stands, growling, facing `dash.to`, until `dash.until`
 * - pounce: dashes straight for `dash.to`, never steering, until there or `dash.until`; each body
 *   it bites on the way goes in `struck`, bitten no more this pounce
 * - skid: slides to a stop and stands until `dash.until`, then wanders, its suspicion spent
 * `source` is what made the last noise it turned to, and `camped` how long it has kept near that
 * maker's noise biting nothing; given up on, the maker goes in `bored` for a while.
 */
/** Most bodies it keeps track of biting at once. */
const MAX_STRUCK = 32;

export const BlindDogState = z.object({
  /** Everyone, to colour it. */
  mode: z.enum(["wander", "stalk", "charge", "crouch", "pounce", "skid"]),
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
  /** The ids of the bodies it bites in this step. Host. */
  bites: z.array(z.string().max(64)).max(MAX_STRUCK),
  /** Where its pounce heads and until when this part of it lasts; null when not pouncing. Host. */
  dash: z.object({ to: Waypoint, until: Time }).nullable(),
  /** The ids of the bodies this pounce has bitten. Host. */
  struck: z.array(z.string().max(64)).max(MAX_STRUCK),
  /** When it next barks; null until the first is drawn. Host. */
  barkAt: Time.nullable(),
  /** Whether it barks in this step. Host. */
  barking: z.boolean(),
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
    bites: [],
    dash: null,
    struck: [],
    barkAt: null,
    barking: false,
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
 * Where a straight dash from `from` heading at `angle` ends: `length` on, short of the first spot a
 * body of half-size `half` no longer fits.
 */
export function dashEnd(
  map: TileMap,
  half: number,
  from: Point,
  angle: number,
  length: number,
): Point {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const step = map.cell / 8;
  let end = from;
  for (let run = Math.min(step, length); run > 0;) {
    const at = { x: from.x + ux * run, y: from.y + uy * run };
    if (!isAreaFree(map, at.x, at.y, half)) break;
    end = at;
    if (run >= length) break;
    run = Math.min(run + step, length);
  }
  return end;
}

/**
 * Turns to a noise heard from `noise`: its suspicion rises by how loud it was, and it walks there,
 * or, suspicion full or already charging, runs there. It keeps its route while that
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
  const route = planRoute(game.world.map, config.radius, at, noise);
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

/** Back to wandering once a noise is followed up, its suspicion spent if it charged or pounced. */
function settle(
  state: BlindDogState,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const spent =
    state.mode === "stalk" || state.mode === "wander"
      ? {}
      : { suspicion: 0, suspectedAt: game.worldTime };
  const settled = {
    ...state,
    ...spent,
    mode: "wander" as const,
    heard: null,
    dash: null,
    struck: [],
  };
  return stand({ ...settled, route: [] }, game, config);
}

/**
 * Crouches to pounce at `target` when it is within reach and nothing stands between: the dash is
 * set now, through `target` and `overrun` on past it, short of the first wall. Null when it cannot.
 */
function crouch(
  state: BlindDogState,
  self: Prey,
  target: Point,
  game: Session,
  config: BlindDogConfig,
): BlindDogState | null {
  const { pounce } = config;
  const distance = Math.hypot(target.x - self.x, target.y - self.y);
  if (distance > pounce.reach) return null;
  const angle =
    distance === 0
      ? state.facing
      : Math.atan2(target.y - self.y, target.x - self.x);
  const to = dashEnd(
    game.world.map,
    config.radius,
    self,
    angle,
    distance + config.overrun,
  );
  // It pounces only when the line reaches its target, near enough to bite it.
  if (Math.hypot(to.x - self.x, to.y - self.y) < distance - config.radius)
    return null;
  return {
    ...state,
    mode: "crouch",
    route: [],
    standUntil: null,
    facing: angle,
    dash: { to, until: game.worldTime + pounce.windup },
    struck: [],
  };
}

/** `body`, when it is a living body it bites within `lunge` of `self`, edge to edge; else null. */
function inLunge(
  self: Prey,
  body: Prey | null,
  game: Session,
  config: BlindDogConfig,
): Prey | null {
  if (body === null || body.id === self.id) return null;
  if (hasKindTag(game, body.id, [...config.ignores, ...NEVER_PREY]))
    return null;
  const gap =
    Math.hypot(body.x - self.x, body.y - self.y) - self.radius - body.radius;
  return gap <= config.lunge ? body : null;
}

/**
 * Commits to what it follows, when it can: at the body that made the noise, when that is a living
 * body it bites within `lunge` of it, else, charging, at where the noise seemed to be. A maker it
 * cannot pounce at from here it goes straight for, so it closes and bites.
 */
function commit(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const maker = inLunge(self, livingBody(game, state.source), game, config);
  if (maker !== null) {
    const crouched = crouch(state, self, maker, game, config);
    return crouched ?? { ...state, route: [{ x: maker.x, y: maker.y }] };
  }
  if (state.mode === "charge" && state.heard !== null)
    return crouch(state, self, state.heard, game, config) ?? state;
  return state;
}

/** Whether it is in the midst of a pounce, which nothing turns it from. */
function pouncing(state: BlindDogState): boolean {
  return (
    state.mode === "crouch" || state.mode === "pounce" || state.mode === "skid"
  );
}

/**
 * Goes on with a pounce it is in: from the crouch it leaps, the dash done (there, or held short by
 * a wall) it skids, and the skid done it settles. It hears nothing meanwhile.
 */
function pounce(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const { dash } = state;
  const now = game.worldTime;
  if (dash === null) return settle(state, game, config);
  const { speed, recover, skid } = config.pounce;
  if (state.mode === "crouch") {
    if (now < dash.until) return state;
    const length = Math.hypot(dash.to.x - self.x, dash.to.y - self.y);
    // Should anything hold it short, the dash is over when it would have been.
    const until = now + length / speed + 0.25;
    return {
      ...state,
      mode: "pounce",
      route: [dash.to],
      dash: { ...dash, until },
    };
  }
  if (state.mode === "pounce") {
    if (state.route.length > 0 && now < dash.until) return state;
    const slide = dashEnd(
      game.world.map,
      config.radius,
      self,
      state.facing,
      skid,
    );
    return {
      ...state,
      mode: "skid",
      route: [slide],
      dash: { to: dash.to, until: now + recover },
    };
  }
  return now < dash.until ? state : settle(state, game, config);
}

/**
 * Counts the time it keeps within `overrun` of the noise it follows, or pounces at it, and once
 * that passes its patience, gives up on what made it: it settles, its suspicion spent, deaf to it
 * a while.
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
  // A pounce at it counts, wherever it carries it; it gives up only once it is over.
  const near =
    pouncing(state) ||
    Math.hypot(heard.x - self.x, heard.y - self.y) <= config.overrun;
  if (!near) return state;
  const camped = state.camped + dt;
  const leaping = state.mode === "crouch" || state.mode === "pounce";
  if (camped < config.patience || leaping) return { ...state, camped };
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
 * What it does next: goes on with a pounce it is in; else turns to what it hears, pouncing once
 * it can, or goes on, settles, or roams.
 */
function think(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  if (pouncing(state)) return pounce(state, self, game, config);
  const { result: earful, seed } = listen(state, self, game);
  const listened = { ...state, seed };
  const { at } = earful;
  if (at !== null)
    return commit(
      react(listened, self, { ...earful, at }, game, config),
      self,
      game,
      config,
    );
  if (listened.mode === "wander") return roam(listened, self, game, config);
  const committed = commit(listened, self, game, config);
  if (committed.mode === "crouch") return committed;
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

/**
 * Bites what it touches: dashing, each body it has not yet bitten this pounce; else everything,
 * once its cooldown is over.
 */
function bite(
  state: BlindDogState,
  self: Prey,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const now = game.worldTime;
  const touched = touching(self, game, config).map((prey) => prey.id);
  const dashing = state.mode === "pounce";
  const bites = dashing
    ? touched.filter((id) => !state.struck.includes(id))
    : now >= state.biteAt
      ? touched
      : [];
  if (bites.length === 0) return { ...state, bites };
  const struck = dashing
    ? [...state.struck, ...bites].slice(-MAX_STRUCK)
    : state.struck;
  return {
    ...state,
    bites: bites.slice(0, MAX_STRUCK),
    struck,
    biteAt: now + config.contactCooldown,
    camped: 0,
  };
}

/**
 * Barks once its time comes, as a sleeper does, while it roams or stalks; charging it roars instead,
 * and through a pounce it growls and bites, so a bark due then is passed over and the next drawn.
 */
function bark(
  state: BlindDogState,
  game: Session,
  config: BlindDogConfig,
): BlindDogState {
  const call = periodicCall(
    state.barkAt,
    game.worldTime,
    state.seed,
    config.barkGap,
  );
  const free = state.mode === "wander" || state.mode === "stalk";
  return {
    ...state,
    seed: call.seed,
    barkAt: call.at,
    barking: call.calls && free,
  };
}

/** A blind dog's sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly bark: Sound;
  readonly roar: Sound;
  readonly snarl: Sound;
  readonly bite: Sound;
  readonly huff: Sound;
  readonly growl: Sound;
  readonly pounce: Sound;
  readonly skid: Sound;
}

/** Sounds, as the host, on every client, what a step from `previous` to `next` did. */
function cue(
  entity: WorldEntity,
  previous: BlindDogState,
  next: BlindDogState,
  game: Session,
  sounds: Sounds,
): void {
  const entered = (mode: Mode): boolean =>
    previous.mode !== mode && next.mode === mode;
  const made = [
    entered("charge") && sounds.roar,
    previous.mode === "wander" && next.mode === "stalk" && sounds.snarl,
    entered("crouch") && sounds.growl,
    entered("pounce") && sounds.pounce,
    entered("skid") && sounds.skid,
    next.bites.length > 0 && sounds.bite,
    next.barking && sounds.bark,
    next.bored !== null &&
      next.bored.until !== previous.bored?.until &&
      sounds.huff,
  ];
  for (const sound of made)
    if (sound !== false) effect(game, { at: entity, sound }, entity);
}

/** How fast it moves in `state`. */
function speedOf(
  state: BlindDogState,
  game: Session,
  config: BlindDogConfig,
): number {
  const { pounce } = config;
  switch (state.mode) {
    case "wander":
      return config.wanderSpeed;
    case "stalk":
      return config.stalkSpeed;
    case "charge":
      return config.chargeSpeed;
    case "crouch":
      return 0;
    case "pounce":
      return pounce.speed;
    case "skid": {
      // It slides from half its dash speed to a stop over the first half of its recovery.
      const left = (state.dash?.until ?? 0) - game.worldTime;
      const sliding = Math.max(0, left / pounce.recover - 0.5) * 2;
      return (pounce.speed / 2) * sliding;
    }
  }
}

const LOOK = {
  body: "#2a2523",
  hide: "#4a403a",
  maw: "#6e1414",
  teeth: "#e9e2d0",
  ring: {
    wander: "#5c5048",
    stalk: "#d8a13a",
    charge: "#d8473a",
    crouch: "#ff3a2a",
    pounce: "#ff3a2a",
    skid: "#a8705a",
  },
  trail: "#d8473a",
  dust: "rgba(170, 150, 130, 0.45)",
} as const;

/**
 * How much it is drawn stretched along the way it faces, and squeezed across it: flattened as it
 * crouches, drawn out as it dashes.
 */
const STRETCH: Partial<Record<Mode, { along: number; across: number }>> = {
  crouch: { along: 0.8, across: 1.15 },
  pounce: { along: 1.4, across: 0.8 },
};

/** Where dust puffs as it skids: ahead and to the side, in radii, and how big. */
const DUST = [
  [0.9, -0.8, 0.35],
  [0.6, 0.9, 0.3],
  [1.1, 0.3, 0.25],
  [0.2, -1.1, 0.25],
] as const;

/** A fading smear of it behind, as it dashes. */
function drawTrail(ctx: CanvasRenderingContext2D, radius: number): void {
  ctx.fillStyle = LOOK.trail;
  for (let ghost = 1; ghost <= 3; ghost++) {
    ctx.globalAlpha = 0.35 * (1 - ghost / 4);
    ctx.beginPath();
    ctx.ellipse(
      -radius * 0.7 * ghost,
      0,
      radius * 1.2,
      radius * (0.8 - ghost * 0.12),
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Dust kicked up about it, as it skids. */
function drawDust(ctx: CanvasRenderingContext2D, radius: number): void {
  ctx.fillStyle = LOOK.dust;
  for (const [ahead, side, size] of DUST) {
    ctx.beginPath();
    ctx.arc(radius * ahead, radius * side, radius * size, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * A heavy dark body, no eyes, a gaping red maw the way it faces, ringed by its mood. Crouched it
 * flattens; dashing it stretches out, a smear of it trailing behind; skidding it kicks up dust.
 */
function drawBlindDog(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: BlindDogState,
): void {
  const { x, y, radius } = entity;
  const { mode } = state;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(state.facing);
  if (mode === "pounce") drawTrail(ctx, radius);
  if (mode === "skid") drawDust(ctx, radius);
  const stretch = STRETCH[mode] ?? { along: 1, across: 1 };
  ctx.scale(stretch.along, stretch.across);
  ctx.fillStyle = LOOK.body;
  ctx.strokeStyle = LOOK.ring[mode];
  ctx.lineWidth = mode === "crouch" ? 5 : 3;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = LOOK.hide;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(
      -Math.cos(side * 0.6) * radius * 0.45,
      -Math.sin(side * 0.6) * radius * 0.45,
      radius * 0.25,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  const gape = mode === "stalk" || mode === "wander" ? 0.45 : 0.75;
  ctx.fillStyle = LOOK.maw;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius * 0.9, -gape, gape);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = LOOK.teeth;
  for (let tooth = -2; tooth <= 2; tooth++) {
    const angle = (tooth / 2.5) * gape;
    const tip = radius * 0.55;
    ctx.beginPath();
    ctx.moveTo(
      Math.cos(angle) * radius * 0.88,
      Math.sin(angle) * radius * 0.88,
    );
    ctx.lineTo(Math.cos(angle + 0.06) * tip, Math.sin(angle + 0.06) * tip);
    ctx.lineTo(Math.cos(angle - 0.06) * tip, Math.sin(angle - 0.06) * tip);
    ctx.fill();
  }
  ctx.restore();
}

function definition(config: BlindDogConfig): EntityDefinition<BlindDogState> {
  const sounds: Sounds = {
    bark: sound({ url: barkUrl, range: config.sounds.bark }),
    roar: sound({ url: roarUrl, range: config.sounds.roar }),
    snarl: sound({ url: snarlUrl, range: config.sounds.snarl }),
    bite: sound({ url: biteUrl, range: config.sounds.bite }),
    huff: sound({ url: huffUrl, range: config.sounds.huff }),
    growl: sound({ url: growlUrl, range: config.sounds.growl }),
    pounce: sound({ url: pounceUrl, range: config.sounds.pounce }),
    skid: sound({ url: skidUrl, range: config.sounds.skid }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    data: BlindDogState,
    update(entity, state, dt, game) {
      const next = bark(
        bite(
          tire(think(state, entity, game, config), entity, dt, game, config),
          entity,
          game,
          config,
        ),
        game,
        config,
      );
      cue(entity, state, next, game, sounds);
      const moved = walk(entity, next, speedOf(next, game, config), dt);
      if (next.mode === "crouch") return { ...moved, facing: next.facing };
      // Dashing, it passes through bodies rather than shoving them along. Its line was clear of
      // walls when it leapt; one in the way since stops it dead.
      entity.collides = next.mode !== "pounce";
      if (next.mode !== "pounce") return moved;
      const ahead = isAreaFree(
        game.world.map,
        entity.x + entity.vx * dt,
        entity.y + entity.vy * dt,
        config.radius,
      );
      if (ahead) return moved;
      entity.vx = 0;
      entity.vy = 0;
      return { ...moved, route: [] };
    },
    strikes(_entity, state): Strike[] {
      return strikeEach(
        state.bites.map((id) => ({ id })),
        config.contactDamage,
      );
    },
    draw(ctx, entity, state) {
      drawBlindDog(ctx, entity, state);
    },
  };
}

/**
 * A blind dog: a hound three cells across, deaf to its own kind. It roams slowly, walks to
 * what it hears and grows suspicious by how loud it was; once suspicion is full it roars and
 * runs for where the last noise came from, steering for each new noise. Near enough, or near the
 * body making a noise, it crouches, growling, then pounces: a straight dash through its target and
 * on past it, biting each body on the line once, then a skid. Anything it touches it bites hard. It barks now
 * and then as it roams or stalks, a noise that draws whatever hears it but other blind dogs. Light does not keep it away: it may appear outdoors
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
