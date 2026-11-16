import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  effect,
  isAreaFree,
  rounded,
  sound,
  spawnWorldItem,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import { drawRing, seenPrey } from "../bodies.js";
import type { Hunting } from "../hunt.js";
import { nearest, Route, Time, walk, Waypoint } from "../hunt.js";
import { layMine, mines } from "../land-mine/index.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The file may not be in yet: a missing one plays nothing, but its noise is still made.
const layUrl = new URL("./sfx/lay.mp3", import.meta.url).href;

/**
 * How a mine layer circles its home, flees what it sees and lays its mines. Distances in pixels,
 * speeds in pixels per second, times in sim seconds.
 */
export interface MineLayerConfig extends Hunting {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  readonly speed: number;
  /** How far it sees, all round it, along a clear line. */
  readonly sightRange: number;
  /** The item it leaves where it arrives, its home; none when the item is not in the game. */
  readonly treasure: string;
  /**
   * Its rounds of its home: rings from `min` to `max` out, each lap `step` further out, then each
   * `step` further in once it reaches `max`, and so on. It heads `leg` along the ring at a time,
   * skipping on round it up to `tries` legs where a wall stands on the ring.
   */
  readonly orbit: {
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly leg: number;
    readonly tries: number;
  };
  /** Seconds between the mines it lays: as it circles, and as it flees. */
  readonly layGap: { readonly wander: number; readonly flee: number };
  /** It lays no mine within this of another. */
  readonly mineSpacing: number;
  /** Seconds it flees after it last saw a body it fears. */
  readonly calmSeconds: number;
  /**
   * How it flees: to the best of `tries` spots `leg` off, scoring each by how far it is from what
   * it fears, less `homePull` times how far it is from home; planned anew every `repathInterval`.
   */
  readonly flee: {
    readonly leg: number;
    readonly tries: number;
    readonly homePull: number;
    readonly repathInterval: number;
  };
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: { readonly lay: number };
}

/**
 * What it is doing, which everyone reads, to draw it:
 * - wander: circles its home along `route`, on the ring `ring` out at `angle`, heading out or in
 * - flee: runs along `route` from the bodies it sees, or from `threat`, where it last saw one,
 *   until `calmAt`
 */
const MODES = ["wander", "flee"] as const;

type Mode = (typeof MODES)[number];

/** Its mode and what it keeps. Only the host reads the rest, and sends it so whoever hosts next goes on from it. */
export const MineLayerState = z.object({
  mode: z.enum(MODES),
  /** Where it arrived, and left its treasure; null before its first step. */
  home: Waypoint.nullable(),
  ring: rounded(1),
  angle: rounded(3),
  outward: z.boolean(),
  route: Route,
  /** When it next lays a mine. */
  layAt: Time,
  threat: Waypoint.nullable(),
  calmAt: Time,
  repathAt: Time,
  facing: rounded(2),
});

export type MineLayerState = z.output<typeof MineLayerState>;

const NAME = "mineLayer";

const GLYPH = "🦀";

const COLOURS: Record<Mode, string> = { wander: "#7d8a5a", flee: "#e0a02a" };

/** A fresh mine layer's state at world time `now`, its home yet to be set. */
export function freshMineLayer(
  now: number,
  config: MineLayerConfig,
): MineLayerState {
  return {
    mode: "wander",
    home: null,
    ring: config.orbit.min,
    angle: 0,
    outward: true,
    route: [],
    layAt: now + config.layGap.wander,
    threat: null,
    calmAt: now,
    repathAt: now,
    facing: 0,
  };
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** Sets its home where it stands, on its first step, and leaves its treasure there. */
function settle(
  state: MineLayerState,
  self: WorldEntity,
  game: Session,
  config: MineLayerConfig,
): MineLayerState {
  if (state.home !== null) return state;
  const home = { x: self.x, y: self.y };
  if (game.itemDefinitions.has(config.treasure))
    spawnWorldItem(game, home, config.treasure);
  return { ...state, home };
}

/**
 * Its next leg round its home: a leg on along the ring, the ring moving a step out or in each lap,
 * turning back at either end, skipping on where a wall stands on the ring or no route reaches it.
 */
function circle(
  state: MineLayerState,
  self: WorldEntity,
  home: Point,
  game: Session,
  config: MineLayerConfig,
): MineLayerState {
  const { map } = game.world;
  const { min, max, step, leg, tries } = config.orbit;
  let { ring, angle, outward } = state;
  for (let attempt = 0; attempt < tries; attempt++) {
    const turn = leg / Math.max(ring, min);
    angle = (angle + turn) % (Math.PI * 2);
    ring += ((outward ? 1 : -1) * step * turn) / (Math.PI * 2);
    if (ring >= max) [ring, outward] = [max, false];
    if (ring <= min) [ring, outward] = [min, true];
    const to = {
      x: home.x + Math.cos(angle) * ring,
      y: home.y + Math.sin(angle) * ring,
    };
    if (!isAreaFree(map, to.x, to.y, self.radius)) continue;
    const route = planRoute(map, self.radius, self, to);
    if (route !== null && route.length > 0)
      return { ...state, ring, angle, outward, route };
  }
  return { ...state, ring, angle, outward, route: [] };
}

/** How far `at` is from the nearest of `threats`; Infinity with none. */
function clearance(threats: readonly Point[], at: Point): number {
  const body = nearest(at, threats);
  return body === null ? Infinity : distance(body, at);
}

/**
 * Its way from `threats`: to the spot a leg off that best keeps it far from them and near home,
 * that a route reaches. None when no spot does.
 */
function fleeRoute(
  self: WorldEntity,
  home: Point,
  threats: readonly Point[],
  game: Session,
  config: MineLayerConfig,
): Point[] {
  const { map } = game.world;
  const { leg, tries, homePull } = config.flee;
  const spots: { at: Point; score: number }[] = [];
  const offset = Math.random() * Math.PI * 2;
  for (let attempt = 0; attempt < tries; attempt++) {
    const angle = offset + (attempt / tries) * Math.PI * 2;
    const at = {
      x: self.x + Math.cos(angle) * leg,
      y: self.y + Math.sin(angle) * leg,
    };
    if (!isAreaFree(map, at.x, at.y, self.radius)) continue;
    spots.push({
      at,
      score: clearance(threats, at) - homePull * distance(home, at),
    });
  }
  spots.sort((a, b) => b.score - a.score);
  for (const { at } of spots) {
    const route = planRoute(map, self.radius, self, at);
    if (route !== null && route.length > 0) return route;
  }
  return [];
}

/** Back to circling its home, from the ring and the way round it it stands at now. */
function calm(
  state: MineLayerState,
  self: WorldEntity,
  home: Point,
  config: MineLayerConfig,
): MineLayerState {
  const { min, max } = config.orbit;
  return {
    ...state,
    mode: "wander",
    threat: null,
    route: [],
    ring: Math.min(max, Math.max(min, distance(self, home))),
    angle: Math.atan2(self.y - home.y, self.x - home.x),
  };
}

/**
 * What it does next: seeing any body it fears, it flees, from all it sees, until it has seen none
 * for its calm time, fleeing meanwhile from where it last saw one; then it circles its home again.
 */
function think(
  state: MineLayerState,
  self: WorldEntity,
  home: Point,
  game: Session,
  config: MineLayerConfig,
): MineLayerState {
  const now = game.worldTime;
  const seen = seenPrey(game, self, config, config.sightRange);
  const closest = nearest(self, seen);
  if (closest !== null) {
    const startled = state.mode !== "flee";
    state = {
      ...state,
      mode: "flee",
      threat: { x: closest.x, y: closest.y },
      calmAt: now + config.calmSeconds,
      layAt: Math.min(state.layAt, now + config.layGap.flee),
      repathAt: startled ? now : state.repathAt,
    };
  }
  if (state.mode === "flee" && now >= state.calmAt)
    return calm(state, self, home, config);
  if (state.mode === "wander")
    return state.route.length > 0
      ? state
      : circle(state, self, home, game, config);
  if (now < state.repathAt && state.route.length > 0) return state;
  const threats: Point[] =
    seen.length > 0 ? seen : state.threat === null ? [] : [state.threat];
  return {
    ...state,
    route: fleeRoute(self, home, threats, game, config),
    repathAt: now + config.flee.repathInterval,
  };
}

/** Whether a mine already lies within its spacing of `at`. */
const mined = (game: Session, at: Point, config: MineLayerConfig): boolean =>
  mines(game).some((mine) => distance(mine, at) < config.mineSpacing);

/**
 * Lays a mine where it stands once its time comes, sooner while it flees, with a sound; none where
 * one already lies close by.
 */
function lay(
  state: MineLayerState,
  self: WorldEntity,
  game: Session,
  config: MineLayerConfig,
  laid: Sound,
): MineLayerState {
  const now = game.worldTime;
  if (now < state.layAt) return state;
  if (!mined(game, self, config)) {
    layMine(game, self);
    effect(game, { at: self, sound: laid }, self);
  }
  const gap = state.mode === "flee" ? config.layGap.flee : config.layGap.wander;
  return { ...state, layAt: now + gap };
}

function definition(
  config: MineLayerConfig,
  laid: Sound,
): EntityDefinition<MineLayerState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: MineLayerState,
    // It sees all round it, but looks down no cone.
    eyes: () => ({ cone: null, around: config.sightRange }),
    update(entity, state, dt, game) {
      const settled = settle(state, entity, game, config);
      const home = settled.home ?? entity;
      const thought = think(settled, entity, home, game, config);
      const next = lay(thought, entity, game, config, laid);
      return walk(entity, next, config.speed, dt);
    },
    draw(ctx, entity, state) {
      drawEmoji(ctx, entity, GLYPH, entity.radius * 2);
      drawRing(ctx, entity, COLOURS[state.mode], 2, 0);
    },
  };
}

/**
 * A mine layer: leaves a golden treasure where it arrives and circles it, ring by ring further out
 * up to a far edge and back in again, laying a land mine every so often. Seeing any body it fears,
 * players and monsters alike, all round it, it runs from them while keeping near home, laying mines
 * faster, until it has seen none for a while. Light is nothing to it: it may arrive in it, and goes
 * through it as through the dark. Its own mines never go off for it.
 */
export const mineLayer = defineEntity(NAME, (config: MineLayerConfig) => {
  const laid = sound({ url: layUrl, range: config.sounds.lay });
  return {
    ...definition(config, laid),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      // It comes out in the light as well as the dark.
      rules: { inLight: true },
      fresh: (_seed: number, game: Session) =>
        freshMineLayer(game.worldTime, config),
    }),
  };
});
