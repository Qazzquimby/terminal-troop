import { z } from "zod";
import { contentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { registerEntityType, removeEntity, spawnEntity } from "./entities.js";
import { addItem, isFull } from "./inventory.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { hostAccepts, ItemId } from "./use.js";

/** How items lie in the world. Distances in pixels, times in sim seconds. */
export interface WorldItemConfig {
  /** A lying item's body; its glyph is drawn to that size. */
  readonly radius: number;
  /** Least time between one player's pickups, as the host counts it. */
  readonly cooldown: number;
}

/** The kind every item lying in the world is, whatever the item. */
const WORLD_ITEM = "core/world-item";

/** What pickups and returns are timed under. */
const PICKUP = "core/world-items.pickUp";
const RETURN = "core/world-items.returned";

/** A lying item's state: which item it is. */
const WorldItemData = z.object({ item: ItemId });

/**
 * Registers the kind items lie in the world as, once a session has any items; each is drawn as
 * its item's glyph. Clients that register the same content number it alike.
 */
export function registerWorldItems(game: Session): void {
  if (game.kindIds.has(WORLD_ITEM)) return;
  const { radius } = game.config.worldItems;
  registerEntityType(game, WORLD_ITEM, {
    radius,
    maxHealth: Infinity,
    collides: false,
    data: WorldItemData,
    draw(ctx, entity, { item }, _now, view) {
      const glyph = view.itemDefinitions.get(item)?.emoji;
      if (glyph === undefined) return;
      ctx.save();
      ctx.font = `${String(radius * 2)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, entity.x, entity.y);
      ctx.restore();
    },
  });
}

/** Lays the item `item` in the world at `at`. */
export function spawnWorldItem(
  game: Session,
  at: Point,
  item: string,
): WorldEntity {
  return spawnEntity(game, WORLD_ITEM, at.x, at.y, { item });
}

/** The item `entity` is, if it is an item lying in the world. */
function lyingItem(game: Session, entity: WorldEntity): string | null {
  if (entity.kind !== game.kindIds.get(WORLD_ITEM)) return null;
  const parsed = WorldItemData.safeParse(entity.data);
  return parsed.success ? parsed.data.item : null;
}

/** A player's reach for a lying item: which one, and where the player stood. */
const PickUp = z.object({
  id: z.string().min(1).max(80),
  x: z.number(),
  y: z.number(),
});

/** An item given back to the world by a player with no room for it, and where it stood. */
const Returned = z.object({ item: ItemId, x: z.number(), y: z.number() });

/**
 * An item the host gave a player who picked it up, for that player's own client to stow. A
 * client with no room left gives it back to the world where its player stands.
 */
export const granted = contentEvent({
  schema: z.object({ item: ItemId }),
  to: "player",
  from: "host",
  receive(game, { item }) {
    const definition = game.itemDefinitions.get(item);
    if (definition === undefined) return;
    if (!addItem(game.local.inventory, definition))
      returned.send(game, { item, x: game.local.x, y: game.local.y });
  },
});

/**
 * A player's pickup, checked by the host: the item still lies in the world, the player's body
 * touches it from where it says it stood, that spot is near where the player was last heard,
 * and the player is off its pickup cooldown. The host takes the item out of the world, which
 * its snapshots carry to everyone, and grants it to the player.
 */
export const pickedUp = contentEvent({
  schema: PickUp,
  to: "host",
  receive(game, at, by) {
    if (!game.hosting) return;
    const entity = game.entities.get(at.id);
    if (entity === undefined) return;
    const item = lyingItem(game, entity);
    if (item === null) return;
    const reach = game.config.player.radius + entity.radius;
    if (Math.hypot(entity.x - at.x, entity.y - at.y) > reach) return;
    if (!hostAccepts(game, by, at, PICKUP, game.config.worldItems.cooldown))
      return;
    removeEntity(game, entity.id);
    granted.send(game, by, { item });
  },
});

/** An item a player had no room for, laid back in the world where it stood, if the host knows it. */
export const returned = contentEvent({
  schema: Returned,
  to: "host",
  receive(game, { item, x, y }, by) {
    if (!game.hosting || !game.itemDefinitions.has(item)) return;
    if (!hostAccepts(game, by, { x, y }, RETURN, 0)) return;
    spawnWorldItem(game, { x, y }, item);
  },
});

/**
 * Reaches for the lying item nearest the local player that its body touches, and asks the host
 * for it. A full inventory reaches for nothing.
 */
export function reachForItem(game: Session): void {
  const { local } = game;
  if (isFull(local.inventory)) return;
  let nearest: WorldEntity | null = null;
  let nearestDistance = Infinity;
  for (const entity of game.entities.values()) {
    if (lyingItem(game, entity) === null) continue;
    const distance = Math.hypot(entity.x - local.x, entity.y - local.y);
    if (distance > local.radius + entity.radius) continue;
    if (distance >= nearestDistance) continue;
    nearest = entity;
    nearestDistance = distance;
  }
  if (nearest !== null)
    pickedUp.send(game, { id: nearest.id, x: local.x, y: local.y });
}
