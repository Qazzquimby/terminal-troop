import {
  eyesOf,
  hasKindTag,
  INERT_TAG,
  ITEM_TAG,
  inView,
  livingBodies,
} from "../sim/index.js";
import type { Body, Point, Session, WorldEntity } from "../sim/index.js";
import { preyNear } from "./hunt.js";
import type { Prey } from "./hunt.js";

/*
 * Who a monster hunts. Players are bodies like any other: a monster hunts, notices, chases and
 * strikes any living body, player or world entity, but itself, inert things, items lying about,
 * and the kinds its config tells it to ignore, its own kind by default.
 */

/** Kind tags no monster hunts, whatever its config says: inert things and items lying about. */
const NEVER_PREY = [INERT_TAG, ITEM_TAG];

/**
 * Every living body `self` may hunt, null for a hunter yet to arrive: players and world entities
 * alike, but itself, inert things, items lying about, and those of the kind tags in `ignores`.
 */
export function preyFor(
  game: Session,
  self: { readonly id: string } | null,
  ignores: readonly string[],
): Body[] {
  const passed = [...ignores, ...NEVER_PREY];
  return livingBodies(game).filter(
    (body) => body.id !== self?.id && !hasKindTag(game, body.id, passed),
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
  ignores: readonly string[],
  range = Infinity,
): Body | null {
  return nearestWithin(self, preyFor(game, self, ignores), range);
}

/**
 * Every body `self` may hunt that it sees with its kind's eyes, within `range` if given, along a
 * clear line. A stunned or blind entity sees none.
 */
export function seenPrey(
  game: Session,
  self: WorldEntity,
  ignores: readonly string[],
  range = Infinity,
): Body[] {
  const sight = eyesOf(game, self);
  if (sight === null) return [];
  return preyFor(game, self, ignores).filter((body) =>
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
  ignores: readonly string[],
  range = Infinity,
): Body | null {
  const sight = eyesOf(game, self);
  if (sight === null) return null;
  let nearest: Body | null = null;
  let nearestDistance = range;
  for (const body of preyFor(game, self, ignores)) {
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
 * inert things, items lying about, and those of the kind tags in `ignores`.
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
