import type { WorldEntity } from "./entities.js";
import type { Point } from "./map.js";
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
