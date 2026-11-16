import {
  eyesOf,
  hasKindTag,
  inCone,
  inView,
  livingBodies,
} from "../sim/index.js";
import type { Body, Point, Session, WorldEntity } from "../sim/index.js";
import { NEVER_PREY, preyNear } from "./hunt.js";
import type { Hunting, Prey } from "./hunt.js";

/*
 * Who a monster hunts. Players are bodies like any other: a monster hunts, notices, chases and
 * strikes any living body, player or world entity, but itself, what `NEVER_PREY` names (inert
 * things, items lying about, unnoticed bodies such as the snail), and the kinds its config tells it
 * to ignore, its own kind by default. A kind whose config names `targets` hunts only bodies of
 * those kind tags, though it still strikes whatever it touches. Nor does it find a body only some
 * other body perceives, as the ghost girl, there to hunt or strike at all.
 */

/**
 * Every living body `self` may hunt, null for a hunter yet to arrive: players and world entities
 * alike, but itself, what `NEVER_PREY` names, those of the kind tags `hunting` ignores,
 * and, when `hunting` names targets, those of none of them.
 */
export function preyFor(
  game: Session,
  self: { readonly id: string } | null,
  hunting: Hunting,
): Body[] {
  const passed = [...hunting.ignores, ...NEVER_PREY];
  const { targets } = hunting;
  return livingBodies(game, self?.id ?? null).filter(
    (body) =>
      body.id !== self?.id &&
      !hasKindTag(game, body.id, passed) &&
      (targets === undefined || hasKindTag(game, body.id, targets)),
  );
}

/** Of `bodies`, the one nearest `at` within `range`; null for none. */
function nearestWithin<T extends Point>(
  at: Point,
  bodies: readonly T[],
  range: number,
): T | null {
  let best: T | null = null;
  let bestDistance = range;
  for (const body of bodies) {
    const distance = Math.hypot(body.x - at.x, body.y - at.y);
    if (distance <= bestDistance) {
      best = body;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The nearest body `self` may hunt within `range` if given, walls or no walls, or null: for kinds
 * that feel or know where their prey is rather than see it.
 */
export function nearestPrey(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body | null {
  return nearestWithin(self, preyFor(game, self, hunting), range);
}

/**
 * Every body `self` may hunt that it sees with its kind's eyes, within `range` if given, along a
 * clear line. A stunned or blind entity sees none.
 */
export function seenPrey(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body[] {
  const sight = eyesOf(game, self);
  if (sight === null) return [];
  return preyFor(game, self, hunting).filter((body) =>
    inView(game, sight, body, range),
  );
}

/**
 * The nearest body `self` may hunt that it sees with its kind's eyes, within `range` if given,
 * along a clear line, or null.
 */
export function nearestSeenBody(
  game: Session,
  self: WorldEntity,
  hunting: Hunting,
  range = Infinity,
): Body | null {
  const sight = eyesOf(game, self);
  if (sight === null) return null;
  let nearest: Body | null = null;
  let nearestDistance = range;
  for (const body of preyFor(game, self, hunting)) {
    const distance = Math.hypot(body.x - self.x, body.y - self.y);
    if (distance > nearestDistance) continue;
    if (!inView(game, sight, body, range)) continue;
    nearest = body;
    nearestDistance = distance;
  }
  return nearest;
}

/**
 * Every body touching `self` that it may hunt: players and world entities alike, but itself,
 * what `NEVER_PREY` names, and those of the kind tags in `ignores`.
 */
export function touching(
  game: Session,
  self: WorldEntity,
  ignores: readonly string[],
): Prey[] {
  return preyNear(game, self, (prey) => self.radius + prey.radius + 1, [
    ...ignores,
    ...NEVER_PREY,
  ]);
}

/** A ring `width` thick round `body`, `colour`ed, `gap` further out than it usually stands. */
export function drawRing(
  ctx: CanvasRenderingContext2D,
  body: Point & { readonly radius: number },
  colour: string,
  width: number,
  gap: number,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(body.x, body.y, body.radius + 2 + gap, 0, Math.PI * 2);
  ctx.stroke();
}

/** Whose gaze holds a kind back, and how far down a body's view cone it reaches. */
export interface Watching extends Hunting {
  /**
   * When given, the only kind tags whose gaze it heeds: "player" heeds players' eyes alone.
   * Absent, any body's gaze but the kinds it ignores.
   */
  readonly watchedBy?: readonly string[];
  /**
   * How far down a body's view cone it counts as watched, light or no light: as far as that body
   * looks, but never past this.
   */
  readonly watchRange: number;
}

/**
 * Whether any living body whose gaze `self` heeds watches a point: it lies within that body's view
 * cone, as far as it looks but no further than the watch range, with nothing in the way. It heeds
 * the kinds `watchedBy` names, or with none named any body but the kinds it ignores. Light plays
 * no part, nor what lies behind a body. A stunned or blind body watches nothing. Make one per
 * step: the bodies' eyes are taken as they stand when it is made.
 */
export function gazeOn(
  game: Session,
  self: { readonly id: string },
  watching: Watching,
): (at: Point) => boolean {
  const sights = livingBodies(game)
    .filter(
      (body) =>
        body.id !== self.id &&
        !hasKindTag(game, body.id, watching.ignores) &&
        (watching.watchedBy === undefined ||
          hasKindTag(game, body.id, watching.watchedBy)),
    )
    .map((body) => eyesOf(game, body))
    .filter((sight) => (sight?.cone ?? null) !== null);
  return (at) =>
    sights.some((sight) => inCone(game, sight, at, watching.watchRange));
}
