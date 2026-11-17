import { z } from "zod";
import {
  canSeeFrom,
  hasKindTag,
  INERT_TAG,
  ITEM_TAG,
  UNNOTICED_TAG,
  livingBodies,
  isAreaFree,
  mulberry32Next,
  noisesHeardBy,
  rounded,
} from "../sim/index.js";
import type {
  Heard,
  Point,
  Rng,
  Session,
  Strike,
  TileMap,
} from "../sim/index.js";
import { MAX_WAYPOINTS, planRoute, routeToNearest, steer } from "./route.js";

/** Something listening: where it stands, its draws, and the kind tags it ignores. */
type Listener = Parameters<typeof noisesHeardBy>[1];

/** What monsters share: the parts of their state on the wire, and how they find and roam. */

/** A point, sent to a tenth of a pixel. */
export const Waypoint = z.object({ x: rounded(1), y: rounded(1) });

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
export const Time = rounded(2);

export const Route = z.array(Waypoint).max(MAX_WAYPOINTS);

/** A mulberry32 state. */
export const Seed = z
  .number()
  .int()
  .min(-(2 ** 31))
  .max(2 ** 31 - 1);

/** Runs `draw` with a generator seeded by `seed`, and returns its result and the state after it. */
export function withSeed<T>(
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

/** A number drawn evenly between `min` and `max`. */
export function between(
  rng: Rng,
  range: { readonly min: number; readonly max: number },
): number {
  return range.min + (range.max - range.min) * rng();
}

/**
 * A call a monster makes now and then, such as a bark: given when it is next due, `at`, or null for
 * one yet to be drawn, whether it calls at `now`, and when it next does, `gap` seconds on, drawn
 * from `seed`. A call first drawn is not made, so a monster just arrived waits a gap before it.
 * Any kind can keep a nullable `Time` and its seed in its state and declare its gap in its config.
 */
export function periodicCall(
  at: number | null,
  now: number,
  seed: number,
  gap: { readonly min: number; readonly max: number },
): { calls: boolean; at: number; seed: number } {
  if (at !== null && now < at) return { calls: false, at, seed };
  const drawn = withSeed(seed, (rng) => between(rng, gap));
  return { calls: at !== null, at: now + drawn.result, seed: drawn.seed };
}

/**
 * Kind tags no monster hunts, notices as prey or strikes, whatever its config says: inert things,
 * items lying about, and bodies every hunter leaves be, such as the snail.
 */
export const NEVER_PREY: readonly string[] = [
  INERT_TAG,
  ITEM_TAG,
  UNNOTICED_TAG,
];

/**
 * The body `self` turns on for hurting it, given who did, `by`: null when no one did, it hurt
 * itself, the one that did is of a kind `NEVER_PREY` names, which no monster goes after even
 * when struck by it, or `hunting` names targets and it is of none of them. Null leaves the
 * monster to its usual quarry.
 */
export function avenged(
  game: Session,
  self: { readonly id: string },
  by: string | null,
  hunting: Pick<Hunting, "targets">,
): string | null {
  if (by === null || by === self.id) return null;
  if (hasKindTag(game, by, NEVER_PREY)) return null;
  const { targets } = hunting;
  if (targets !== undefined && !hasKindTag(game, by, targets)) return null;
  return by;
}

/** Who a monster kind passes over, which its config says. */
export interface Hunting {
  /**
   * Kind tags it neither hunts nor strikes, its own kind as a rule; "player" spares players. No
   * monster hunts what `NEVER_PREY` names, whatever this says.
   */
  readonly ignores: readonly string[];
  /**
   * When given, the only kind tags it picks as quarry: "player" hunts players alone. Absent, it
   * hunts any body it does not ignore. It narrows only whom it goes after; it still strikes
   * whatever it touches that it does not ignore.
   */
  readonly targets?: readonly string[];
}

/** A body a monster may hunt. */
export interface Prey extends Point {
  readonly id: string;
  readonly radius: number;
}

/**
 * Every living player and world entity within `reach` of `hunter`, measured centre to centre,
 * but items lying about and those of the kind tags in `ignores`.
 */
export function preyNear(
  game: Session,
  hunter: Prey,
  reach: (prey: Prey) => number,
  ignores: readonly string[],
): Prey[] {
  const near: Prey[] = [];
  for (const body of livingBodies(game, hunter.id)) {
    if (body.id === hunter.id) continue;
    const distance = Math.hypot(body.x - hunter.x, body.y - hunter.y);
    if (distance > reach(body)) continue;
    if (hasKindTag(game, body.id, [...ignores, ITEM_TAG])) continue;
    near.push(body);
  }
  return near;
}

/** The clearest of the noises `listener` hears this step; null for none. */
export function clearestNoise(game: Session, listener: Listener): Heard | null {
  let clearest: Heard | null = null;
  for (const heard of noisesHeardBy(game, listener))
    if (clearest === null || heard.clarity > clearest.clarity) clearest = heard;
  return clearest;
}

/**
 * The loudest, where `listener` stands, of the noises it hears this step that carry at least
 * `radius` from where they were made: a gunshot, a blast, a horn, whatever its maker. Null for
 * none. For a kind that rouses at a noise big enough, however far off.
 */
export function bigNoise(
  game: Session,
  listener: Listener,
  radius: number,
): Heard | null {
  let loudest: Heard | null = null;
  for (const heard of noisesHeardBy(game, listener)) {
    if (heard.radius < radius) continue;
    if (loudest === null || heard.loudness > loudest.loudness) loudest = heard;
  }
  return loudest;
}

/** Of `bodies`, the one nearest `at`; null for none. */
export function nearest<T extends Point>(
  at: Point,
  bodies: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const body of bodies) {
    const distance = Math.hypot(body.x - at.x, body.y - at.y);
    if (distance < bestDistance) {
      best = body;
      bestDistance = distance;
    }
  }
  return best;
}

/** Random points tried for a wander leg before standing a while longer. */
const LEG_ATTEMPTS = 8;

/**
 * A route for a body of half-size `half` at `at` to a random point it fits at within `range` of
 * `around`, as the crow flies, or null when none of the tries finds one. Round where it stands
 * unless told otherwise; round a home keeps a wanderer from drifting off.
 */
export function wanderLeg(
  map: TileMap,
  at: Point,
  rng: Rng,
  half: number,
  range: number,
  around: Point = at,
): Point[] | null {
  for (let attempt = 0; attempt < LEG_ATTEMPTS; attempt++) {
    const angle = rng() * Math.PI * 2;
    const distance = range * Math.sqrt(rng());
    const to = {
      x: around.x + Math.cos(angle) * distance,
      y: around.y + Math.sin(angle) * distance,
    };
    if (!isAreaFree(map, to.x, to.y, half)) continue;
    // A wanderer keeps to the open ways: it has no need of the other side of a door.
    const route = planRoute(map, half, at, to, undefined, undefined, false);
    if (route !== null && route.length > 0) return route;
  }
  return null;
}

/**
 * Steps `body` along `state`'s route at `speed` for `dt`, and returns `state` with the route left
 * and the way the body now faces.
 */
export function walk<S extends { route: Point[]; facing: number }>(
  body: Point & { vx: number; vy: number },
  state: S,
  speed: number,
  dt: number,
): S {
  const route = steer(body, state.route, speed, dt);
  return { ...state, route, facing: faced(body, state.facing) };
}

/** A strike of `amount` on each of `bodies`. */
export function strikeEach(
  bodies: readonly { readonly id: string }[],
  amount: number,
): Strike[] {
  return bodies.map((body) => ({ target: body.id, amount }));
}

/** Which way a body heading at velocity (`vx`, `vy`) faces; `facing` while it stands still. */
function faced(
  body: { readonly vx: number; readonly vy: number },
  facing: number,
): number {
  return body.vx === 0 && body.vy === 0 ? facing : Math.atan2(body.vy, body.vx);
}

/**
 * `state` striking this step, at world time `now`, when `able` and its cooldown is over, after
 * which it waits `cooldown` seconds.
 */
export function strikeIf<
  S extends { readonly attackAt: number; readonly attacking: boolean },
>(state: S, now: number, able: boolean, cooldown: number): S {
  const attacking = able && now >= state.attackAt;
  if (!attacking) return { ...state, attacking };
  return { ...state, attacking, attackAt: now + cooldown };
}

/** How a body flees: to the best of `tries` spots `leg` off, as `fleeRoute` scores them. */
export interface Fleeing {
  readonly leg: number;
  readonly tries: number;
  /** How much each pixel from home costs a spot, against each pixel from what it fears; 0 none. */
  readonly homePull?: number;
}

/** How far `at` is from the nearest of `threats`; Infinity with none. */
function clearance(threats: readonly Point[], at: Point): number {
  const body = nearest(at, threats);
  return body === null ? Infinity : Math.hypot(body.x - at.x, body.y - at.y);
}

/**
 * A way for `self` from `threats`: to the spot a leg off, of those tried evenly round it, that best
 * keeps it far from them and, with a home and a pull to it, near home, that a route reaches. None
 * when no spot does.
 */
export function fleeRoute(
  map: TileMap,
  self: Point & { readonly radius: number },
  threats: readonly Point[],
  { leg, tries, homePull = 0 }: Fleeing,
  home: Point = self,
): Point[] {
  const spots: { at: Point; score: number }[] = [];
  const offset = Math.random() * Math.PI * 2;
  for (let attempt = 0; attempt < tries; attempt++) {
    const angle = offset + (attempt / tries) * Math.PI * 2;
    const at = {
      x: self.x + Math.cos(angle) * leg,
      y: self.y + Math.sin(angle) * leg,
    };
    if (!isAreaFree(map, at.x, at.y, self.radius)) continue;
    const fromHome = Math.hypot(home.x - at.x, home.y - at.y);
    spots.push({ at, score: clearance(threats, at) - homePull * fromHome });
  }
  spots.sort((a, b) => b.score - a.score);
  for (const { at } of spots) {
    // A body in flight has no time to get through a door.
    const route = planRoute(
      map,
      self.radius,
      self,
      at,
      undefined,
      undefined,
      false,
    );
    if (route !== null && route.length > 0) return route;
  }
  return [];
}

/** A body's middle and four points round its edge, as offsets from its middle over its radius. */
const FOOTPRINT = [
  [0, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, Math.SQRT1_2],
] as const;

/**
 * Whether any part of a body of `radius` standing at `at`, its middle or an edge, lies along a
 * clear line within `range` of any of `eyes`, whichever way they face: where they see it, or would
 * by turning.
 */
export function inSightOfAny(
  map: TileMap,
  eyes: readonly Point[],
  at: Point,
  radius: number,
  range: number,
): boolean {
  return FOOTPRINT.some(([dx, dy]) => {
    const point = { x: at.x + dx * radius, y: at.y + dy * radius };
    return eyes.some((eye) => canSeeFrom(map, { ...eye, range }, point));
  });
}

/**
 * The quickest way for `self` out of the sight of all of `eyes`, as `inSightOfAny` has it: to the
 * first spot, by the walk there, that none of them sees within `range` even by turning. Not the
 * spot furthest from them nor the one nearest home, but the soonest it can stand unseen, round a
 * corner or past where they see to. Empty when it already is; null when no spot it reaches is
 * hidden. Any kind that flees sight rather than distance can take it.
 */
export function coverRoute(
  map: TileMap,
  self: Point & { readonly radius: number },
  eyes: readonly Point[],
  range: number,
): Point[] | null {
  const seen = (at: Point): boolean =>
    inSightOfAny(map, eyes, at, self.radius, range);
  if (!seen(self)) return [];
  return routeToNearest(map, self.radius, self, (at) => !seen(at));
}
