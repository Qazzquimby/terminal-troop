import { z } from "zod";
import type { WorldEntity } from "./entities.js";
import { ItemId, ItemState, UsesLeft } from "./inventory.js";
import type { Session } from "./session.js";
import { heldParser } from "./parse-cache.js";

/** The kind every item lying in the world is, whatever the item. */
export const WORLD_ITEM = "core/world-item";

/**
 * A lying item's state: which item it is, the uses it has left once it has spent some, its own
 * state once it keeps any, and the way it points, in radians, once that is other than 0: the way
 * whoever laid it faced, so a flashlight dropped switched on shines on that way.
 */
export const WorldItemData = z.object({
  item: ItemId,
  left: UsesLeft.optional(),
  state: ItemState.optional(),
  facing: z.number().optional(),
});
export type WorldItemData = z.infer<typeof WorldItemData>;

/** Lying items are looked over by every light, scanner and eye a step: parsed once each. */
const parseLying = heldParser(WorldItemData);

/**
 * A lying item's state: `item` with `left` uses left, or all its uses when left out, keeping
 * `state` of its own, if any, pointing `facing` radians, 0 when left out.
 */
export const lyingData = (
  item: string,
  left?: number | null,
  state?: ItemState,
  facing?: number,
): WorldItemData => ({
  item,
  ...(left !== undefined && left !== null && { left }),
  ...(state !== undefined && Object.keys(state).length > 0 && { state }),
  ...(facing !== undefined && facing !== 0 && { facing }),
});

/**
 * The item `entity` is, the uses it has left and its own state, if it is an item lying in the
 * world.
 */
export function lyingItem(
  game: Session,
  entity: WorldEntity,
): WorldItemData | null {
  if (entity.kind !== game.kindIds.get(WORLD_ITEM)) return null;
  const parsed = parseLying(entity.data);
  return parsed.success ? parsed.data : null;
}
