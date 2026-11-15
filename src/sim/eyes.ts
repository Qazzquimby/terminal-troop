import { asEntity, asPlayer, livingBodies } from "./bodies.js";
import type { Body } from "./bodies.js";
import { isGhost } from "./ghosts.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { isStunned } from "./status.js";
import { canSeeFrom } from "./vision.js";

/*
 * Every body can have eyes: a player by its aim, a world entity by its kind's `eyes`. Eyes see two
 * ways, kept apart on purpose:
 * - looking: down the view cone. What lies in a body's cone along a clear line is what it looks
 *   at, as the statue, held while looked at, asks.
 * - noticing: looking, or within the circle it sees all round it, behind it too. A flash, or a
 *   body it reacts to, need only be noticed.
 * Light plays no part: a body looking into the dark at something still looks at it.
 */

/** A view cone: the way it faces and how wide it is, in radians, and how far it reaches. */
interface Cone {
  readonly direction: number;
  readonly angle: number;
  readonly range: number;
}

/** How a body sees, from where it stands. */
export interface Eyes {
  /** The cone it looks down; null for none. */
  readonly cone: Cone | null;
  /** How far it sees all round it, behind it too; 0 for not at all. */
  readonly around: number;
}

/** Eyes, and where they see from. */
export interface Sight extends Eyes, Point {}

/**
 * The eyes of `body` as it is now, or null while it sees nothing: blind kinds, ghosts, the dead and
 * the stunned. A player looks down its aim, with the cone, look range and surroundings of
 * `config.vision`.
 */
export function eyesOf(game: Session, body: Body): Sight | null {
  if (isStunned(game, body.id)) return null;
  const player = asPlayer(game, body);
  if (player !== null) {
    if (isGhost(player)) return null;
    const { coneAngle, surroundingsRadius, lookRange } = game.config.vision;
    return {
      x: player.x,
      y: player.y,
      cone: { direction: player.aim, angle: coneAngle, range: lookRange },
      around: surroundingsRadius,
    };
  }
  const entity = asEntity(game, body);
  if (entity === null || entity.health <= 0) return null;
  const eyes = game.entityTypes.get(entity.kind)?.eyes(entity, game) ?? null;
  return eyes === null ? null : { x: entity.x, y: entity.y, ...eyes };
}

/** Whether `sight` sees `at` down its cone, within `range`, along a clear line. */
export function inCone(
  game: Session,
  sight: Sight | null,
  at: Point,
  range = Infinity,
): boolean {
  const cone = sight?.cone ?? null;
  if (sight === null || cone === null) return false;
  const source = {
    x: sight.x,
    y: sight.y,
    range: Math.min(cone.range, range),
    shape: {
      kind: "cone" as const,
      direction: cone.direction,
      angle: cone.angle,
    },
  };
  return canSeeFrom(game.world.map, source, at);
}

/**
 * Whether `sight` sees `at` at all: down its cone, or within the circle it sees all round it;
 * within `range`, and along a clear line either way.
 */
export function inView(
  game: Session,
  sight: Sight | null,
  at: Point,
  range = Infinity,
): boolean {
  if (sight === null) return false;
  if (inCone(game, sight, at, range)) return true;
  const around = Math.min(sight.around, range);
  return (
    around > 0 &&
    canSeeFrom(game.world.map, { x: sight.x, y: sight.y, range: around }, at)
  );
}

/**
 * Whether `body` looks at `at`: it lies in its view cone, within `range` if given, along a clear
 * line. The circle it sees all round it does not count.
 */
export const looksAt = (
  game: Session,
  body: Body,
  at: Point,
  range = Infinity,
): boolean => inCone(game, eyesOf(game, body), at, range);

/**
 * Whether `body` notices `at`: it looks at it, or `at` lies within the circle it sees all round
 * it; within `range` if given, and along a clear line either way.
 */
export const notices = (
  game: Session,
  body: Body,
  at: Point,
  range = Infinity,
): boolean => inView(game, eyesOf(game, body), at, range);

/** Which bodies to leave out of who looks. */
export interface Lookers {
  /** Whether to leave `body` out, such as the looked-at body's own kind. */
  readonly except?: (body: Body) => boolean;
}

/** Whether `body` counts as looking at `at`: not `at` itself, nor left out, and looking at it. */
const looker =
  (game: Session, at: Point, { except }: Lookers) =>
  (body: Body): boolean =>
    body !== at && !(except?.(body) ?? false) && looksAt(game, body, at);

/**
 * Every living body that looks at `at`, down its view cone along a clear line, but those `except`
 * leaves out. A body in whose surroundings `at` merely lies does not look at it.
 */
export const lookersAt = (
  game: Session,
  at: Point,
  lookers: Lookers = {},
): Body[] => livingBodies(game).filter(looker(game, at, lookers));

/** Whether any living body, but those `except` leaves out, looks at `at`. */
export const isLookedAt = (
  game: Session,
  at: Point,
  lookers: Lookers = {},
): boolean => livingBodies(game).some(looker(game, at, lookers));
