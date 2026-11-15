import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  effect,
  isAreaFree,
  hurtSinceLastStep,
  isGone,
  isLit,
  livingBody,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { drawRing, nearestSeenBody, preyFor, touching } from "../bodies.js";
import type { Hunting } from "../hunt.js";
import {
  between,
  Route,
  strikeEach,
  Time,
  Waypoint,
  wanderLeg,
  avenged,
} from "../hunt.js";
import { avoidingLight, planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const barkUrl = new URL("./sfx/bark.mp3", import.meta.url).href;
const growlUrl = new URL("./sfx/growl.mp3", import.meta.url).href;
const enrageUrl = new URL("./sfx/enrage.mp3", import.meta.url).href;
const rageBarkUrl = new URL("./sfx/rage-bark.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/** Seconds between two sounds of one kind, drawn between the two. */
interface Gap {
  readonly min: number;
  readonly max: number;
}

/**
 * The sleeper: sleeps in the dark until light or a body close by wakes her, then runs down
 * whoever she sees for a while before slinking off to a dark corner to sleep again. Distances in
 * pixels, times in sim seconds; she runs at a player's sprint.
 */
export interface SleeperConfig extends Hunting {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** How far she sees, all round her, along a clear line. */
  readonly sightRange: number;
  /** How close a body she sees, player or monster, must be to wake her. */
  readonly wakeRange: number;
  /** Seconds she growls at a body that close before she wakes, if they are still there. */
  readonly warnSeconds: number;
  /** Seconds she stays enraged, unless she kills before then. */
  readonly rageSeconds: number;
  /** Furthest an enraged wander leg heads from where it starts. */
  readonly wanderRange: number;
  /** How far sighted prey must be from where the chase is headed before she plans anew. */
  readonly repathDistance: number;
  /** Damage dealt to each body she touches while enraged. */
  readonly attackDamage: number;
  readonly attackCooldown: number;
  /** Seconds between barks: dormant, and enraged. */
  readonly barkGap: { readonly dormant: Gap; readonly enraged: Gap };
  /** Where she sleeps again: a dark spot this far off, and this far from every body she hunts. */
  readonly retreat: {
    readonly distance: { readonly min: number; readonly max: number };
    readonly clearance: number;
    readonly tries: number;
  };
  /** How far, in pixels, each of her sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly bark: number;
    readonly growl: number;
    readonly enrage: number;
    readonly rageBark: number;
    readonly attack: number;
  };
}

/**
 * What she is doing, which everyone reads, to draw her:
 * - dormant: sits still, barking now and then
 * - warning: growls at a body close by, until `until`, then wakes if they are still there
 * - enraged: runs down `target`, where she last saw prey, or wanders fast, until `until`
 * - retreat: runs for a dark spot away from what she hunts, along `route`, and sleeps there
 */
const MODES = ["dormant", "warning", "enraged", "retreat"] as const;

type Mode = (typeof MODES)[number];

/**
 * Her mode and what she keeps. Only the host reads the rest, and sends it so that whoever hosts
 * next goes on from it.
 */
export const SleeperState = z.object({
  mode: z.enum(MODES),
  until: Time,
  route: Route,
  target: Waypoint.nullable(),
  barkAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  /** The body that hurt her, which she runs down while it lives, until she retreats. */
  foe: z.string().nullable(),
  /** The body she last struck, to tell when she has killed. */
  victim: z.string().nullable(),
});

export type SleeperState = z.output<typeof SleeperState>;

const NAME = "sleeper";

const SLEEPER_GLYPH = "🧙‍♀️";

const COLOURS: Record<Mode, string> = {
  dormant: "#6b5a8a",
  warning: "#d8a13a",
  enraged: "#e0342a",
  retreat: "#4a6070",
};

/** A fresh, dormant sleeper's state at world time `now`. */
export function freshSleeper(now: number, config: SleeperConfig): SleeperState {
  return {
    mode: "dormant",
    until: now,
    route: [],
    target: null,
    barkAt: now + between(Math.random, config.barkGap.dormant),
    attackAt: now,
    attacking: false,
    foe: null,
    victim: null,
  };
}

/** The speed she runs at whenever she moves: a player's sprint. */
function runSpeed(game: Session): number {
  const { player } = game.config;
  return player.speed * player.sprintMultiplier;
}

/** A point drawn `min` to `max` from `at`, any way. */
function pointAround(at: Point, min: number, max: number): Point {
  const angle = Math.random() * Math.PI * 2;
  const distance = min + (max - min) * Math.sqrt(Math.random());
  return {
    x: at.x + Math.cos(angle) * distance,
    y: at.y + Math.sin(angle) * distance,
  };
}

/** Wakes in a rage: stays enraged for a while, starting from no target. */
function enrage(state: SleeperState, game: Session, config: SleeperConfig) {
  return {
    ...state,
    mode: "enraged" as const,
    until: game.worldTime + config.rageSeconds,
    route: [],
    target: null,
  };
}

/** Goes back to sleep where she is. */
function sleep(state: SleeperState): SleeperState {
  return { ...state, mode: "dormant", route: [], target: null, foe: null };
}

/**
 * A dark spot she may retreat to from `self`, far enough from every body she hunts, and her route
 * there: kept off lit ground where it can be, straight through it where it cannot. Null when none
 * of the tries finds one.
 */
function hideout(
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): Point[] | null {
  const { map } = game.world;
  const { distance, clearance } = config.retreat;
  const avoid = avoidingLight(game);
  const hunted = preyFor(game, self, config);
  for (let attempt = 0; attempt < config.retreat.tries; attempt++) {
    const to = pointAround(self, distance.min, distance.max);
    if (!isAreaFree(map, to.x, to.y, self.radius) || isLit(game, to)) continue;
    const near = hunted.some(
      (body) => Math.hypot(body.x - to.x, body.y - to.y) < clearance,
    );
    if (near) continue;
    const route =
      planRoute(map, self.radius, self, to, avoid) ??
      planRoute(map, self.radius, self, to);
    if (route !== null && route.length > 0) return route;
  }
  return null;
}

/** Runs off to a dark hideout, or sleeps where she is when she finds none. */
function retreat(
  state: SleeperState,
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  const route = hideout(self, game, config);
  if (route === null) return sleep(state);
  return { ...state, mode: "retreat", route, target: null };
}

/** Heads for `seen`, planning anew unless she already heads close enough to it. */
function pursue(
  state: SleeperState,
  self: WorldEntity,
  seen: Point,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  const { target, route: heading } = state;
  const onCourse =
    heading.length > 0 &&
    target !== null &&
    Math.hypot(target.x - seen.x, target.y - seen.y) <= config.repathDistance;
  if (onCourse) return state;
  const route = planRoute(game.world.map, self.radius, self, seen) ?? [
    { x: seen.x, y: seen.y },
  ];
  return { ...state, route, target: { x: seen.x, y: seen.y } };
}

/**
 * Enraged: runs down whatever body hurt her, wherever it is, while it lives; otherwise the nearest
 * body she sees, to where she last saw it; with neither, she wanders fast. Light is nothing to her
 * now.
 */
function rage(
  state: SleeperState,
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  const seen =
    livingBody(game, state.foe) ??
    nearestSeenBody(game, self, config, config.sightRange);
  if (seen !== null) return pursue(state, self, seen, game, config);
  if (state.route.length > 0) return state;
  const { map } = game.world;
  const leg = wanderLeg(
    map,
    self,
    Math.random,
    self.radius,
    config.wanderRange,
  );
  return { ...state, target: null, route: leg ?? [] };
}

/** Whether she sees a living body she hunts within her wake range. */
function bodyClose(
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): boolean {
  return nearestSeenBody(game, self, config, config.wakeRange) !== null;
}

/** The state sleeper `self` moves to this step. */
function think(
  state: SleeperState,
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  const now = game.worldTime;
  const hurt = hurtSinceLastStep(game, self.id);
  const by = avenged(game, self, hurt?.by ?? null);
  const marked =
    by === null || state.mode === "retreat" ? state : { ...state, foe: by };
  return respond(marked, self, game, config, hurt !== null, now);
}

/** What she does in her mode, `hurt` or not since her last step, at world time `now`. */
function respond(
  state: SleeperState,
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
  hurt: boolean,
  now: number,
): SleeperState {
  switch (state.mode) {
    case "dormant":
    case "warning": {
      if (hurt || isLit(game, self)) {
        const woken = enrage(state, game, config);
        return hurt ? rage(woken, self, game, config) : woken;
      }
      const close = bodyClose(self, game, config);
      if (state.mode === "dormant")
        return close
          ? { ...state, mode: "warning", until: now + config.warnSeconds }
          : state;
      if (now < state.until) return state;
      return close ? enrage(state, game, config) : sleep(state);
    }
    case "enraged": {
      const killed = state.victim !== null && isGone(game, state.victim);
      if (killed || now >= state.until)
        return retreat(
          { ...state, victim: null, foe: null },
          self,
          game,
          config,
        );
      return rage(state, self, game, config);
    }
    case "retreat":
      return state.route.length > 0 ? state : sleep(state);
  }
}

/** Strikes, while enraged and once the cooldown is over, whatever she touches. */
function attack(
  state: SleeperState,
  self: WorldEntity,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  if (state.mode !== "enraged" || game.worldTime < state.attackAt)
    return { ...state, attacking: false };
  const struck = touching(game, self, config.ignores)[0];
  if (struck === undefined) return { ...state, attacking: false };
  return {
    ...state,
    attacking: true,
    attackAt: game.worldTime + config.attackCooldown,
    victim: struck.id,
  };
}

/** Barks once her time comes, more often when enraged; she is quiet as she slinks off. */
function bark(
  state: SleeperState,
  game: Session,
  config: SleeperConfig,
): SleeperState {
  if (game.worldTime < state.barkAt || state.mode === "retreat") return state;
  const gap =
    state.mode === "enraged" ? config.barkGap.enraged : config.barkGap.dormant;
  return { ...state, barkAt: game.worldTime + between(Math.random, gap) };
}

/** Her sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly bark: Sound;
  readonly growl: Sound;
  readonly enrage: Sound;
  readonly rageBark: Sound;
  readonly attack: Sound;
}

/**
 * Sounds, as the host, on every client, what a step from `previous` to `next` did: a growl as she
 * warns, a scream as she wakes enraged, a bark, which is harsher enraged, or a strike.
 */
function cue(
  entity: WorldEntity,
  previous: SleeperState,
  next: SleeperState,
  game: Session,
  sounds: Sounds,
): void {
  const barked = next.barkAt !== previous.barkAt;
  const made = [
    previous.mode !== "warning" && next.mode === "warning" && sounds.growl,
    previous.mode !== "enraged" && next.mode === "enraged" && sounds.enrage,
    barked && (next.mode === "enraged" ? sounds.rageBark : sounds.bark),
    next.attacking && sounds.attack,
  ];
  for (const cry of made)
    if (cry !== false) effect(game, { at: entity, sound: cry }, entity);
}

function definition(config: SleeperConfig): EntityDefinition<SleeperState> {
  const sounds: Sounds = {
    bark: sound({ url: barkUrl, range: config.sounds.bark }),
    growl: sound({ url: growlUrl, range: config.sounds.growl }),
    enrage: sound({ url: enrageUrl, range: config.sounds.enrage }),
    rageBark: sound({ url: rageBarkUrl, range: config.sounds.rageBark }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: SleeperState,
    // She sees all round her, asleep or awake, but looks down no cone.
    eyes: () => ({
      cone: null,
      around: Math.max(config.sightRange, config.wakeRange),
    }),
    update(entity, state, dt, game) {
      const acted = attack(
        think(state, entity, game, config),
        entity,
        game,
        config,
      );
      const next = bark(acted, game, config);
      cue(entity, state, next, game, sounds);
      const route = steer(entity, next.route, runSpeed(game), dt);
      return { ...next, route };
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return strikeEach(
        touching(game, entity, config.ignores),
        config.attackDamage,
      );
    },
    draw(ctx, entity, state, now) {
      const size = entity.radius * (state.mode === "enraged" ? 2.4 : 2);
      drawEmoji(ctx, entity, SLEEPER_GLYPH, size);
      const { mode } = state;
      const pulse = mode === "warning" ? 2 * Math.abs(Math.sin(now * 12)) : 0;
      drawRing(ctx, entity, COLOURS[mode], mode === "enraged" ? 3 : 2, pulse);
    },
  };
}

/**
 * The sleeper: sits dormant in the dark, barking now and then. Light on her, or a body she sees
 * close by for a moment after her growl, a player or a monster alike, wakes her enraged: she
 * screams, then for a while runs at a player's sprint after whoever she sees, or whoever hurts her,
 * to where she last saw them, wandering fast with no one in sight. Once she kills, or her rage runs
 * out, she runs for a dark spot away from what she hunts and sleeps there. She arrives now and
 * then, out of the world's start, of the light and of every player's sight.
 */
export const sleeper = defineEntity(NAME, (config: SleeperConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) =>
      freshSleeper(game.worldTime, config),
  }),
}));
