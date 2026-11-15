import { z } from "zod";
import {
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
import { MAX_WAYPOINTS, planRoute, steer } from "./route.js";

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
 * itself, or the one that did is of a kind `NEVER_PREY` names, which no monster goes after even
 * when struck by it.
 */
export function avenged(
  game: Session,
  self: { readonly id: string },
  by: string | null,
): string | null {
  if (by === null || by === self.id) return null;
  return hasKindTag(game, by, NEVER_PREY) ? null : by;
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
  for (const body of livingBodies(game)) {
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
 * A route for a body of half-size `half` to a random point it fits at within `range` of `at`, as
 * the crow flies, or null when none of the tries finds one.
 */
export function wanderLeg(
  map: TileMap,
  at: Point,
  rng: Rng,
  half: number,
  range: number,
): Point[] | null {
  for (let attempt = 0; attempt < LEG_ATTEMPTS; attempt++) {
    const angle = rng() * Math.PI * 2;
    const distance = range * Math.sqrt(rng());
    const to = {
      x: at.x + Math.cos(angle) * distance,
      y: at.y + Math.sin(angle) * distance,
    };
    if (!isAreaFree(map, to.x, to.y, half)) continue;
    const route = planRoute(map, half, at, to);
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
