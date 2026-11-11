import { lastFreePointAlong } from "./collision.js";
import type { Entity } from "./entity.js";
import { isAreaFree } from "./map.js";
import type { Point, TileMap } from "./map.js";

/**
 * What a knockback does when a wall is in its way:
 * - stop: the entity goes as far as it fits along the way
 * - stay: the entity does not move unless it fits where the push would leave it
 */
export type Blocked = "stop" | "stay";

/**
 * Pushes `entity` `distance` pixels straight away from `from`. An entity standing exactly at
 * `from` has no direction to go, and stays.
 */
export function knockBack(
  entity: Entity,
  from: Point,
  distance: number,
  map: TileMap,
  blocked: Blocked,
): void {
  const dx = entity.x - from.x;
  const dy = entity.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const to = {
    x: entity.x + (dx / length) * distance,
    y: entity.y + (dy / length) * distance,
  };
  switch (blocked) {
    case "stop": {
      const reached = lastFreePointAlong(map, entity.radius, entity, to);
      entity.x = reached.x;
      entity.y = reached.y;
      return;
    }
    case "stay":
      if (isAreaFree(map, to.x, to.y, entity.radius)) {
        entity.x = to.x;
        entity.y = to.y;
      }
  }
}
