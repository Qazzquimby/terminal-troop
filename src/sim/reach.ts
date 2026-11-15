import { livingBodies } from "./bodies.js";
import type { Body } from "./bodies.js";
import type { WorldEntity } from "./entities.js";
import { livingPlayers } from "./ghosts.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/** A round patch of the world. */
export interface Circle {
  readonly center: Point;
  readonly radius: number;
}

/** The circle of `radius` centred `distance` in front of `at`, facing `aim` (radians). */
export function circleAhead(
  at: Point,
  aim: number,
  distance: number,
  radius: number,
): Circle {
  return {
    center: {
      x: at.x + Math.cos(aim) * distance,
      y: at.y + Math.sin(aim) * distance,
    },
    radius,
  };
}

/** Every world entity that touches `area`. Players are not world entities. */
export function entitiesIn(game: Session, area: Circle): WorldEntity[] {
  const { center, radius } = area;
  return [...game.entities.values()].filter(
    (entity) =>
      Math.hypot(entity.x - center.x, entity.y - center.y) <=
      radius + entity.radius,
  );
}

/** Every living player that touches `area`, but the one with id `but`, if given. */
export function playersIn(game: Session, area: Circle, but?: string): Player[] {
  const { center, radius } = area;
  return livingPlayers(game).filter(
    (player) =>
      player.id !== but &&
      Math.hypot(player.x - center.x, player.y - center.y) <=
        radius + player.radius,
  );
}

/**
 * Every body that touches `area`, living players and world entities alike, items lying about
 * included, but the one with id `but`, if given.
 */
export function bodiesIn(game: Session, area: Circle, but?: string): Body[] {
  const { center, radius } = area;
  return livingBodies(game).filter(
    (body) =>
      body.id !== but &&
      Math.hypot(body.x - center.x, body.y - center.y) <= radius + body.radius,
  );
}
