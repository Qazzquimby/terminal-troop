import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  bodyById,
  canSeeFrom,
  defineEntity,
  effect,
  eyesOf,
  hasKindTag,
  inCone,
  inView,
  isAboard,
  isShutIn,
  isAreaFree,
  isGone,
  livingPlayers,
  sound,
  teleport,
  UNNOTICED_TAG,
} from "../../sim/index.js";
import type {
  Apparition,
  Body,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { between, Route, strikeIf, Time, Waypoint } from "../hunt.js";
import { planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const stareUrls = [new URL("./sfx/stare.mp3", import.meta.url).href];
const chaseUrl = new URL("./sfx/chase.mp3", import.meta.url).href;
const appearUrl = new URL("./sfx/appear.mp3", import.meta.url).href;
const vanishUrl = new URL("./sfx/vanish.mp3", import.meta.url).href;

/** A spread of seconds, drawn evenly between the two. */
interface Spread {
  readonly min: number;
  readonly max: number;
}

/**
 * The ghost girl: a haunting only the body she has chosen perceives. Distances in pixels, times
 * in sim seconds, speeds as shares of a player's sprint.
 */
export interface GhostGirlConfig {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** The kind tags of the bodies she may choose to haunt: "player" haunts players alone. */
  readonly targets: readonly string[];
  /** Seconds she stays away, entirely unseen, before she next tries to appear. */
  readonly absent: Spread;
  /** Where she appears to stare. */
  readonly appear: {
    /** Nearest and furthest from her target she appears. */
    readonly near: number;
    readonly far: number;
    /** Radians past the edge of her target's view cone, at least, that she appears. */
    readonly behind: number;
    /** Spots tried in a step before trying again later. */
    readonly tries: number;
    /** Seconds before trying again when no spot would do. */
    readonly retry: number;
  };
  /** How long she stares. */
  readonly patience: {
    /** What she starts a stare with. */
    readonly start: number;
    /** Lost every second. */
    readonly drain: number;
    /** Lost every second her target has no clear line to her. */
    readonly unseen: number;
    /** Lost every second her target looks at her. */
    readonly watched: number;
  };
  /** When and how she runs her target down. */
  readonly chase: {
    /** Least anger at which being looked at may set her on her target. */
    readonly from: number;
    /** The chance it does at that anger, and how much more for each anger past it. */
    readonly chance: number;
    readonly chancePerAnger: number;
    /** Her speed at that anger, and how much faster for each anger past it, up to `maxSpeed`. */
    readonly speed: number;
    readonly speedPerAnger: number;
    readonly maxSpeed: number;
    /** Seconds a chase lasts. */
    readonly seconds: Spread;
  };
  /** How she slips away once her patience is out. */
  readonly hide: {
    /** Furthest from her she looks for a spot out of her target's sight. */
    readonly range: number;
    /** Spots tried each step. */
    readonly tries: number;
    /** Seconds she looks before making for the nearest wall instead. */
    readonly search: number;
    /** Her walk, as a share of a sprint. */
    readonly speed: number;
    /** Seconds after which she is gone, wherever she has got to. */
    readonly giveUp: number;
  };
  /** Seconds she flickers before she vanishes at the end of a chase. */
  readonly flicker: number;
  /** How she shows, out in the world: see-through, shaking and staticky. */
  readonly apparition: Apparition;
  /** What touching her target costs it in a chase: `damage` every `interval` seconds. */
  readonly contact: { readonly damage: number; readonly interval: number };
  /** How far her sounds carry: heard by her target alone, however far it carries. */
  readonly soundRange: number;
}

/**
 * What she is doing, and for whom:
 * - absent: gone, parked off the map, until `until`, when she tries to appear
 * - staring: stands and stares at her target until her patience runs out; on the cabin's
 *   minimap instead, while `onMinimap`
 * - disappearing: walks somewhere her target cannot see, along `route`, then is gone
 * - chasing: goes straight for her target through walls until `until`
 * - vanishing: flickers, still, until `until`, then is gone
 */
export const GhostGirlState = z.object({
  mode: z.enum(["absent", "staring", "disappearing", "chasing", "vanishing"]),
  /** The body she haunts, by id; null until she has found one. */
  target: z.string().nullable(),
  anger: z.number().int().min(0),
  patience: z.number(),
  /** Whether her target has looked at her this stare. */
  seen: z.boolean(),
  onMinimap: z.boolean(),
  until: Time,
  /** Until when, disappearing, she looks for a hiding spot; then makes for a wall. */
  searchUntil: Time,
  hide: Waypoint.nullable(),
  route: Route,
  attackAt: Time,
  attacking: z.boolean(),
});

export type GhostGirlState = z.output<typeof GhostGirlState>;

const NAME = "ghostGirl";

const GLYPH = "👧";

/**
 * Where she waits while absent: far above and left of the map, so she is placed at once wherever
 * she appears, and never in a pocket, which all lie below it, so no pocketball counts her there.
 */
const PARKED: Point = { x: -100_000, y: -100_000 };

/** A fresh ghost girl's state at world time `now`: absent, with no one to haunt yet. */
export function freshGhostGirl(now: number): GhostGirlState {
  return {
    mode: "absent",
    target: null,
    anger: 0,
    patience: 0,
    seen: false,
    onMinimap: false,
    until: now,
    searchUntil: now,
    hide: null,
    route: [],
    attackAt: now,
    attacking: false,
  };
}

/** Her sounds, each heard by her target alone. */
interface Sounds {
  readonly stare: readonly Sound[];
  readonly chase: Sound;
  readonly appear: Sound;
  readonly vanish: Sound;
}

/** Whether `body` is inside a vehicle, off its wheel: looking at the cabin, not the world. */
function inCabin(game: Session, body: Body): boolean {
  if (!isAboard(body)) return false;
  return game.players.get(body.id)?.ride?.driving !== true;
}

/**
 * How `target` sees her: with its eyes, but down its cone however far, as she shows to it in the
 * dark at any distance. Null while it sees nothing, or is inside a vehicle.
 */
function sightOf(game: Session, target: Body): ReturnType<typeof eyesOf> {
  if (isAboard(target)) return null;
  const sight = eyesOf(game, target);
  if (sight === null) return null;
  const { cone } = sight;
  return cone === null
    ? sight
    : { ...sight, cone: { ...cone, range: Infinity } };
}

/** Gone: parked off the map, her stare and route dropped, back in `absent` seconds. */
function goAbsent(
  state: GhostGirlState,
  self: WorldEntity,
  game: Session,
  config: GhostGirlConfig,
): GhostGirlState {
  teleport(game, self, PARKED);
  return {
    ...state,
    mode: "absent",
    seen: false,
    onMinimap: false,
    hide: null,
    route: [],
    attacking: false,
    until: game.worldTime + between(Math.random, config.absent),
  };
}

/** A body she may haunt, drawn at random: one of the kinds she targets, alive and not her. */
function chooseTarget(
  game: Session,
  self: WorldEntity,
  config: GhostGirlConfig,
): string | null {
  const candidates = [
    ...livingPlayers(game),
    ...[...game.entities.values()].filter((entity) => entity.health > 0),
  ].filter(
    (body) =>
      body.id !== self.id &&
      !isGone(game, body.id) &&
      hasKindTag(game, body.id, config.targets),
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]?.id ?? null;
}

/** A random one of `sounds`. */
const anyOf = (sounds: readonly Sound[]): Sound | undefined =>
  sounds[Math.floor(Math.random() * sounds.length)];

/**
 * A spot to stare at `target` from: free ground between the near and far distances, at least the
 * configured angle past the edge of its view cone, with a clear line to it. Null when no try finds
 * one.
 */
function staringSpot(
  game: Session,
  target: Body,
  config: GhostGirlConfig,
): Point | null {
  const { map } = game.world;
  const { near, far, behind, tries } = config.appear;
  const cone = eyesOf(game, target)?.cone ?? null;
  // Straight behind, give or take as much as the cone and the margin past it leave.
  const facing = cone?.direction ?? Math.random() * Math.PI * 2;
  const spread =
    cone === null ? Math.PI : Math.max(0, Math.PI - cone.angle / 2 - behind);
  for (let attempt = 0; attempt < tries; attempt++) {
    const angle = facing + Math.PI + (Math.random() * 2 - 1) * spread;
    const reach = near + (far - near) * Math.random();
    const at = {
      x: target.x + Math.cos(angle) * reach,
      y: target.y + Math.sin(angle) * reach,
    };
    if (!isAreaFree(map, at.x, at.y, config.radius)) continue;
    if (canSeeFrom(map, target, at)) return at;
  }
  return null;
}

/** Whether being looked at sets her on her target, at her anger now. */
function enraged(anger: number, config: GhostGirlConfig): boolean {
  const { from, chance, chancePerAnger } = config.chase;
  if (anger < from) return false;
  return Math.random() < chance + chancePerAnger * (anger - from);
}

/** Sets her on her target, for a chase's seconds, its sound heard by her target. */
function startChase(
  state: GhostGirlState,
  self: WorldEntity,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  effect(game, { at: self, sound: sounds.chase }, self);
  return {
    ...state,
    mode: "chasing",
    onMinimap: false,
    route: [],
    until: game.worldTime + between(Math.random, config.chase.seconds),
  };
}

/** Her target sees her now, for the first time this stare: angrier, and maybe set on it. */
function lookedAt(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  const anger = state.anger + 1;
  const angry = { ...state, seen: true, anger };
  if (!enraged(anger, config)) return angry;
  // Off the minimap, she comes for her target where it is.
  if (state.onMinimap) teleport(game, self, target);
  return startChase(angry, self, game, config, sounds);
}

/**
 * Absent until her time comes, then appears to stare at her target: over the cabin's minimap if
 * it is in the cabin, where it sees her at once; otherwise somewhere behind it with a clear line
 * to it, or, with no such spot, she tries again a little later.
 */
function absent(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  const now = game.worldTime;
  if (self.x !== PARKED.x || self.y !== PARKED.y) teleport(game, self, PARKED);
  if (now < state.until) return state;
  const stare = anyOf(sounds.stare);
  const staring = {
    ...state,
    mode: "staring" as const,
    patience: config.patience.start,
    seen: false,
    route: [],
  };
  if (inCabin(game, target)) {
    if (stare !== undefined) effect(game, { at: target, sound: stare }, self);
    return lookedAt(
      { ...staring, onMinimap: true },
      self,
      target,
      game,
      config,
      sounds,
    );
  }
  const at = staringSpot(game, target, config);
  if (at === null) return { ...state, until: now + config.appear.retry };
  teleport(game, self, at);
  effect(game, { at, sound: sounds.appear }, self);
  if (stare !== undefined) effect(game, { at, sound: stare }, self);
  return { ...staring, onMinimap: false };
}

/** Starts slipping away: looking for somewhere her target cannot see. */
function disappear(
  state: GhostGirlState,
  game: Session,
  config: GhostGirlConfig,
): GhostGirlState {
  const now = game.worldTime;
  return {
    ...state,
    mode: "disappearing",
    hide: null,
    route: [],
    searchUntil: now + config.hide.search,
    until: now + config.hide.giveUp,
  };
}

/**
 * Stares, standing still, until her patience runs out: it drains every second, comes back while
 * her target has no clear line to her, and holds while it looks at her. The first look of a stare
 * angers her. Over the minimap, it drains alone, and she goes once her target leaves the cabin.
 */
function staring(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  dt: number,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  const { drain, unseen, watched } = config.patience;
  if (state.onMinimap) {
    if (!inCabin(game, target)) return goAbsent(state, self, game, config);
    const patience = state.patience - drain * dt;
    if (patience > 0) return { ...state, patience };
    effect(game, { at: target, sound: sounds.vanish }, self);
    return goAbsent(state, self, game, config);
  }
  const sight = sightOf(game, target);
  const clear = !isAboard(target) && canSeeFrom(game.world.map, target, self);
  const looking = inCone(game, sight, self);
  const rate = -drain - (clear ? 0 : unseen) - (looking ? watched : 0);
  const next = { ...state, patience: state.patience + rate * dt };
  if (looking && !state.seen) {
    const angered = lookedAt(next, self, target, game, config, sounds);
    if (angered.mode === "chasing") return angered;
    return angered.patience > 0 ? angered : disappear(angered, game, config);
  }
  return next.patience > 0 ? next : disappear(next, game, config);
}

/** The middle of the wall cell nearest `at`, within `range`; null for none. */
function nearestWall(game: Session, at: Point, range: number): Point | null {
  const { cell, cols, rows, solid } = game.world.map;
  const col = Math.floor(at.x / cell);
  const row = Math.floor(at.y / cell);
  const rings = Math.ceil(range / cell);
  let best: Point | null = null;
  let bestDistance = Infinity;
  for (let dr = -rings; dr <= rings; dr++)
    for (let dc = -rings; dc <= rings; dc++) {
      const c = col + dc;
      const r = row + dr;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      if (solid[r * cols + c] !== 1) continue;
      const middle = { x: (c + 0.5) * cell, y: (r + 0.5) * cell };
      const distance = Math.hypot(middle.x - at.x, middle.y - at.y);
      if (distance < bestDistance) {
        best = middle;
        bestDistance = distance;
      }
    }
  return best;
}

/** A spot near her that her target cannot see, and her route there; null when no try finds one. */
function hidingSpot(
  game: Session,
  self: WorldEntity,
  sight: ReturnType<typeof eyesOf>,
  config: GhostGirlConfig,
): { hide: Point; route: Point[] } | null {
  const { map } = game.world;
  const { range, tries } = config.hide;
  for (let attempt = 0; attempt < tries; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const reach = range * Math.sqrt(Math.random());
    const at = {
      x: self.x + Math.cos(angle) * reach,
      y: self.y + Math.sin(angle) * reach,
    };
    if (!isAreaFree(map, at.x, at.y, config.radius)) continue;
    if (inView(game, sight, at)) continue;
    const route = planRoute(map, config.radius, self, at);
    if (route !== null && route.length > 0) return { hide: at, route };
  }
  return null;
}

/**
 * Slips away: gone the moment her target cannot see her. Until then she walks to a spot it cannot
 * see; when she has looked long enough for one in vain, or got there still seen, into the nearest
 * wall. However it goes, she is gone in the end.
 */
function disappearing(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  game: Session,
  config: GhostGirlConfig,
): GhostGirlState {
  const now = game.worldTime;
  const sight = sightOf(game, target);
  if (!inView(game, sight, self) || now >= state.until)
    return goAbsent(state, self, game, config);
  if (state.route.length > 0) return state;
  if (state.hide === null && now < state.searchUntil) {
    const found = hidingSpot(game, self, sight, config);
    return found === null ? state : { ...state, ...found };
  }
  const wall = nearestWall(game, self, config.hide.range);
  if (wall === null) return goAbsent(state, self, game, config);
  return { ...state, hide: wall, route: [wall] };
}

/** Whether she touches `target`, out in the world. */
const touchesTarget = (
  game: Session,
  self: WorldEntity,
  target: Body,
): boolean =>
  !isShutIn(game, target) &&
  Math.hypot(target.x - self.x, target.y - self.y) <=
    self.radius + target.radius + 1;

/** Her chase's speed at her anger now. */
function chaseSpeed(
  game: Session,
  anger: number,
  config: GhostGirlConfig,
): number {
  const { player } = game.config;
  const { from, speed, speedPerAnger, maxSpeed } = config.chase;
  const share = Math.min(
    maxSpeed,
    speed + speedPerAnger * Math.max(0, anger - from),
  );
  return player.speed * player.sprintMultiplier * share;
}

/**
 * Goes straight for her target, through walls, striking it while she touches it, until the chase
 * is up; then flickers, still, and vanishes.
 */
function chasing(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  dt: number,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  const now = game.worldTime;
  if (now >= state.until) {
    effect(game, { at: self, sound: sounds.vanish }, self);
    return {
      ...state,
      mode: "vanishing",
      attacking: false,
      until: now + config.flicker,
    };
  }
  const speed = chaseSpeed(game, state.anger, config);
  steer(self, [{ x: target.x, y: target.y }], speed, dt);
  return strikeIf(
    state,
    now,
    touchesTarget(game, self, target),
    config.contact.interval,
  );
}

/** The state she moves to this step, about `target`, the body she haunts. */
function think(
  state: GhostGirlState,
  self: WorldEntity,
  target: Body,
  dt: number,
  game: Session,
  config: GhostGirlConfig,
  sounds: Sounds,
): GhostGirlState {
  switch (state.mode) {
    case "absent":
      return absent(state, self, target, game, config, sounds);
    case "staring":
      return staring(state, self, target, dt, game, config, sounds);
    case "disappearing":
      return disappearing(state, self, target, game, config);
    case "chasing":
      return chasing(state, self, target, dt, game, config, sounds);
    case "vanishing":
      return game.worldTime < state.until
        ? state
        : goAbsent(state, self, game, config);
  }
}

/** How she moves this step: along her route, at her walk or her chase's speed; still otherwise. */
function move(
  state: GhostGirlState,
  self: WorldEntity,
  dt: number,
  game: Session,
  config: GhostGirlConfig,
): GhostGirlState {
  if (state.mode === "chasing") return state;
  if (state.mode !== "disappearing") {
    self.vx = 0;
    self.vy = 0;
    return state;
  }
  const { player } = game.config;
  const speed = player.speed * player.sprintMultiplier * config.hide.speed;
  return { ...state, route: steer(self, state.route, speed, dt) };
}

/** Whether she shows out in the world, to her target. */
const inWorld = (state: GhostGirlState): boolean =>
  state.mode !== "absent" && !state.onMinimap;

/** Whether she shows at `now`, in milliseconds, as she flickers: on and off, unevenly. */
function flickerOn(now: number): boolean {
  const beat = Math.floor(now / 45);
  return (Math.sin(beat * 12.9898) * 43758.5453) % 1 > -0.2;
}

/** Static over a `size` square, freshly drawn each frame. */
function drawStatic(ctx: CanvasRenderingContext2D, size: number): void {
  const grain = Math.max(2, Math.round(size / 60));
  for (let y = 0; y < size; y += grain)
    for (let x = 0; x < size; x += grain) {
      const shade = Math.floor(Math.random() * 255);
      ctx.fillStyle = `rgba(${String(shade)}, ${String(shade)}, ${String(shade)}, 0.55)`;
      ctx.fillRect(x, y, grain, grain);
    }
}

function definition(config: GhostGirlConfig): EntityDefinition<GhostGirlState> {
  const sounds: Sounds = {
    stare: stareUrls.map((url) =>
      sound({ url, volume: 0.5, range: config.soundRange }),
    ),
    chase: sound({ url: chaseUrl, range: config.soundRange }),
    appear: sound({ url: appearUrl, range: config.soundRange }),
    vanish: sound({ url: vanishUrl, range: config.soundRange }),
  };
  return {
    radius: config.radius,
    // She cannot die, nor be hurt: nothing but her target perceives her, and it cannot touch her.
    maxHealth: Infinity,
    mass: Infinity,
    // She passes through walls, and nothing bumps into her.
    collides: false,
    tags: [UNNOTICED_TAG],
    data: GhostGirlState,
    // She is there for her target alone, and for no one while she has none.
    perceivedBy: (_entity, state) => state.target,
    seenInDark: true,
    // Out in the world she is see-through, shaking and staticky; flickering out, the static
    // lingers where she was.
    apparition: (_entity, state) => (inWorld(state) ? config.apparition : null),
    update(entity, arrived, dt, game) {
      const target = isGone(game, arrived.target ?? "")
        ? null
        : bodyById(game, arrived.target);
      // With her target gone, or none yet, she chooses another, her anger gone, and stays away.
      if (target === null) {
        const chosen = chooseTarget(game, entity, config);
        const absent = { ...arrived, target: chosen, anger: 0 };
        return arrived.mode === "absent" &&
          arrived.target === null &&
          chosen === null
          ? absent
          : goAbsent(absent, entity, game, config);
      }
      const next = think(arrived, entity, target, dt, game, config, sounds);
      return move(next, entity, dt, game, config);
    },
    strikes(_entity, state): Strike[] {
      if (state.mode !== "chasing" || !state.attacking || state.target === null)
        return [];
      return [{ target: state.target, amount: config.contact.damage }];
    },
    draw(ctx, entity, state, now) {
      if (!inWorld(state)) return;
      if (state.mode === "vanishing" && !flickerOn(now)) return;
      // Bolder as she comes for her target; see-through, shaking and staticky always.
      ctx.globalAlpha *= state.mode === "chasing" ? 1 : 0.8;
      drawEmoji(ctx, entity, GLYPH, entity.radius * 2.4);
    },
    minimap(ctx, _entity, state, size) {
      if (state.mode !== "staring" || !state.onMinimap) return;
      drawStatic(ctx, size);
      // She shakes where she stands.
      const shake = size / 40;
      const at = {
        x: size / 2 + (Math.random() * 2 - 1) * shake,
        y: size / 2 + (Math.random() * 2 - 1) * shake,
      };
      ctx.globalAlpha = 0.85;
      drawEmoji(ctx, at, GLYPH, size * 0.55);
    },
  };
}

/**
 * The ghost girl: she cannot die. She chooses a body to haunt, a player as configured, and is
 * there for it alone: no other body sees, hears, hunts or touches her, no other client draws her
 * or plays her sounds, and the cruiser's minimap never shows her. Her target sees her even in the
 * dark, however far, wherever it has a clear line to her. Should it go, she chooses another, her
 * anger gone. She stays away a while, then appears behind it, out of its view cone, with a clear
 * line to it, and stares until her patience runs out. The first time it looks at her in a stare
 * angers her; from three anger on, a look may set her on it, through walls, at a speed growing
 * with her anger, hurting it while she touches it, until she flickers and vanishes. Otherwise she
 * slips away somewhere it cannot see. In the cruiser's cabin, she shakes in the static over the
 * minimap instead, seen at once.
 */
export const ghostGirl = defineEntity(NAME, (config: GhostGirlConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) => freshGhostGirl(game.worldTime),
  }),
}));
