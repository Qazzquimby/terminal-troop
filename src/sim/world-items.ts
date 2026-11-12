import { z } from "zod";
import { contentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { registerEntityType, removeEntity, spawnEntity } from "./entities.js";
import { addItem, isFull, removeItem } from "./inventory.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { makeSound } from "./sound.js";
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

/** What pickups and drops are timed under. */
const PICKUP = "core/world-items.pickUp";
const DROP = "core/world-items.dropped";

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

/** An item a player let go of, and where it stood. */
const Dropped = z.object({ item: ItemId, x: z.number(), y: z.number() });

/**
 * An item the host laid in the world, for every client to hear land where it was dropped: its
 * item's drop sound, if it has one.
 */
export const landed = contentEvent({
  schema: Dropped,
  to: "all",
  from: "host",
  receive(game, { item, x, y }) {
    const sound = game.itemDefinitions.get(item)?.drop;
    if (sound !== undefined) makeSound(game, sound, { x, y });
  },
});

/**
 * An item a player let go of, laid in the world where it stood if the host knows the item and
 * the spot is near where the player was last heard. The player's own client has already taken
 * it out of its inventory.
 */
export const dropped = contentEvent({
  schema: Dropped,
  to: "host",
  receive(game, { item, x, y }, by) {
    if (!game.hosting || !game.itemDefinitions.has(item)) return;
    if (!hostAccepts(game, by, { x, y }, DROP, 0)) return;
    spawnWorldItem(game, { x, y }, item);
    landed.send(game, { item, x, y });
  },
});

/** Lets go of `item` where the local player stands, for the host to lay in the world. */
function letGo(game: Session, item: string): void {
  dropped.send(game, { item, x: game.local.x, y: game.local.y });
}

/**
 * An item the host gave a player who picked it up, for that player's own client to stow. A
 * client with no room left drops it where its player stands.
 */
export const granted = contentEvent({
  schema: z.object({ item: ItemId }),
  to: "player",
  from: "host",
  receive(game, { item }) {
    const definition = game.itemDefinitions.get(item);
    if (definition === undefined) return;
    if (!addItem(game.local.inventory, definition)) letGo(game, item);
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

/** The lying item nearest the local player that its body touches, if any. */
function nearestTouching(game: Session): WorldEntity | null {
  const { local } = game;
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
  return nearest;
}

/**
 * The local player's interaction with lying items: picks up the nearest it touches, if it has
 * room; otherwise drops the item it holds where it stands, if any.
 */
export function interact(game: Session): void {
  const { local } = game;
  const nearest = isFull(local.inventory) ? null : nearestTouching(game);
  if (nearest !== null) {
    pickedUp.send(game, { id: nearest.id, x: local.x, y: local.y });
    return;
  }
  if (local.held === null) return;
  const item = removeItem(local.inventory, local.held);
  if (item !== null) letGo(game, item.id);
}
