import { z } from "zod";
import { contentEvent } from "./content-event.js";
import type { WorldEntity } from "./entities.js";
import { registerEntityType, removeEntity, spawnEntity } from "./entities.js";
import {
  giveItem,
  hasRoom,
  isReaching,
  itemIn,
  predictInventory,
  settleItemAction,
  takeItem,
} from "./inventories.js";
import { addItem, isFull, ItemId, removeItem } from "./inventory.js";
import type { Point } from "./map.js";
import { nextAction } from "./prediction.js";
import type { Session } from "./session.js";
import { makeSound } from "./sound.js";
import { hostAccepts } from "./use.js";

/** How items lie in the world. Distances in pixels, times in sim seconds. */
export interface WorldItemConfig {
  /** A lying item's body; its glyph is drawn to that size. */
  readonly radius: number;
  /** Least time between one player's pickups, as the host counts it. */
  readonly cooldown: number;
  /** Least time between one player's drops, as the host counts it. */
  readonly dropCooldown: number;
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

/** A local action's number, for the host to confirm. */
const Action = z.number().int().positive();

/** A player's reach for a lying item: which one, where the player stood, and its action number. */
const PickUp = z.object({
  id: z.string().min(1).max(80),
  x: z.number(),
  y: z.number(),
  action: Action,
});

/** An item laid in the world, and where. */
const Landed = z.object({ item: ItemId, x: z.number(), y: z.number() });

/** An item a player let go of: the slot it held it in, where it stood, and its action number. */
const Dropped = Landed.extend({
  slot: z.number().int().min(0),
  action: Action,
});

/**
 * An item the host laid in the world, for every client to hear land where it was dropped: its
 * item's drop sound, if it has one.
 */
export const landed = contentEvent({
  schema: Landed,
  to: "all",
  from: "host",
  receive(game, { item, x, y }) {
    const sound = game.itemDefinitions.get(item)?.drop;
    if (sound !== undefined) makeSound(game, sound, { x, y });
  },
});

/**
 * An item a player let go of, laid in the world where it stood if the host's record has the item
 * in the slot it names, the spot is near where the player was last heard, and the player is off
 * its drop cooldown. The host takes the item out of the player's slot as it lays it.
 */
export const dropped = contentEvent({
  schema: Dropped,
  to: "host",
  receive(game, { item, slot, x, y, action }, by) {
    if (!game.hosting) return;
    settleItemAction(game, by, action);
    if (itemIn(game, by, slot) !== item) return;
    const { dropCooldown } = game.config.worldItems;
    if (!hostAccepts(game, by, { x, y }, DROP, dropCooldown)) return;
    takeItem(game, by, slot, item);
    spawnWorldItem(game, { x, y }, item);
    landed.send(game, { item, x, y });
  },
});

/**
 * A player's pickup, checked by the host: the item still lies in the world, the player's body
 * touches it from where it says it stood, that spot is near where the player was last heard,
 * the player has room for it in the host's record, and is off its pickup cooldown. The host
 * takes the item out of the world, which its snapshots carry to everyone, and puts it in the
 * player's first empty slot.
 */
export const pickedUp = contentEvent({
  schema: PickUp,
  to: "host",
  receive(game, at, by) {
    if (!game.hosting) return;
    settleItemAction(game, by, at.action);
    const entity = game.entities.get(at.id);
    if (entity === undefined) return;
    const item = lyingItem(game, entity);
    if (item === null) return;
    const reach = game.config.player.radius + entity.radius;
    if (Math.hypot(entity.x - at.x, entity.y - at.y) > reach) return;
    if (!hasRoom(game, by)) return;
    if (!hostAccepts(game, by, at, PICKUP, game.config.worldItems.cooldown))
      return;
    removeEntity(game, entity.id);
    giveItem(game, by, item);
  },
});

/** The lying item nearest the local player that its body touches, if any. */
function nearestTouching(game: Session): WorldEntity | null {
  const { local } = game;
  let nearest: WorldEntity | null = null;
  let nearestDistance = Infinity;
  for (const entity of game.entities.values()) {
    if (lyingItem(game, entity) === null || isReaching(game, entity.id))
      continue;
    const distance = Math.hypot(entity.x - local.x, entity.y - local.y);
    if (distance > local.radius + entity.radius) continue;
    if (distance >= nearestDistance) continue;
    nearest = entity;
    nearestDistance = distance;
  }
  return nearest;
}

/** Whether the local player is off its own cooldown for `key`; if so, starts `cooldown` of it. */
function ready(game: Session, key: string, cooldown: number): boolean {
  if (game.time < (game.localReadyAt.get(key) ?? -Infinity)) return false;
  game.localReadyAt.set(key, game.time + cooldown);
  return true;
}

/**
 * The local player's interaction with lying items: picks up the nearest it touches, if it has
 * room; otherwise drops the item it holds where it stands, if any. Either shows in its items at
 * once, until the host's record settles it.
 */
export function interact(game: Session): void {
  const { local } = game;
  const { cooldown, dropCooldown } = game.config.worldItems;
  const nearest = isFull(local.inventory) ? null : nearestTouching(game);
  if (nearest !== null) {
    const item = lyingItem(game, nearest);
    const definition =
      item === null ? undefined : game.itemDefinitions.get(item);
    if (definition === undefined || !ready(game, PICKUP, cooldown)) return;
    const action = nextAction(game);
    predictInventory(
      game,
      action,
      (inventory) => addItem(inventory, definition),
      nearest.id,
    );
    pickedUp.send(game, { id: nearest.id, x: local.x, y: local.y, action });
    return;
  }
  const slot = local.held;
  const item = slot === null ? null : (local.inventory[slot] ?? null);
  if (slot === null || item === null) return;
  if (!ready(game, DROP, dropCooldown)) return;
  const action = nextAction(game);
  predictInventory(game, action, (inventory) => removeItem(inventory, slot));
  dropped.send(game, { item: item.id, slot, x: local.x, y: local.y, action });
}
