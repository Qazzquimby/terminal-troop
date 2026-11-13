import { z } from "zod";
import {
  defineAction,
  effect,
  give,
  removeFromWorld,
  spawn,
  take,
} from "./actions.js";
import type { WorldEntity } from "./entities.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { hasRoom, isReaching, itemIn } from "./inventories.js";
import { isFull, ItemId } from "./inventory.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";

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

const Spot = { x: z.number(), y: z.number() };

/**
 * A player's pickup of a lying item, from where it stood. The host takes it if the item still
 * lies in the world, the player's body touches it from there, and the host's record has room for
 * it; it takes the item out of the world, which its snapshots carry to everyone, then puts it in
 * the player's first empty slot. The player's own client shows it in its items at once, and does
 * not reach for it again while the host answers.
 */
export const pickUp = defineAction("pickUp", {
  input: z.object({ id: z.string().min(1).max(80), ...Spot }),
  cooldown: (game) => game.config.worldItems.cooldown,
  stood: (_player, { x, y }) => ({ at: { x, y } }),
  check(game, player, { id, x, y }) {
    const entity = game.entities.get(id);
    if (entity === undefined || lyingItem(game, entity) === null) return false;
    const reach = game.config.player.radius + entity.radius;
    return (
      Math.hypot(entity.x - x, entity.y - y) <= reach &&
      hasRoom(game, player.id)
    );
  },
  apply(game, player, { id }) {
    const entity = game.entities.get(id);
    const item = entity === undefined ? null : lyingItem(game, entity);
    if (entity === undefined || item === null) return;
    removeFromWorld(game, entity);
    give(game, player, item);
  },
});

/**
 * A player letting go of the item in a slot, where it stood. The host takes it if its record has
 * an item in the slot: it takes the item out of the slot and lays it in the world there. The
 * player's own client shows it gone from its items at once, and every client hears it land, with
 * its item's drop sound, if it has one.
 */
export const drop = defineAction("drop", {
  input: z.object({ slot: z.number().int().min(0).max(63), ...Spot }),
  cooldown: (game) => game.config.worldItems.dropCooldown,
  stood: (_player, { x, y }) => ({ at: { x, y } }),
  check: (game, player, { slot }) => itemIn(game, player.id, slot) !== null,
  apply(game, player, { slot, x, y }) {
    const item = take(game, player, slot);
    if (item === null) return;
    const at = { x, y };
    spawn(game, WORLD_ITEM, at, { item });
    const sound = game.itemDefinitions.get(item)?.drop;
    if (sound === undefined) return;
    effect(game, {
      at,
      sound,
      ...(sound.noise !== undefined && { noise: sound.noise }),
    });
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

/**
 * The local player's interaction with lying items: picks up the nearest it touches, if it has
 * room; otherwise drops the item it holds where it stands, if any.
 */
export function interact(game: Session): void {
  const { local } = game;
  const at = { x: local.x, y: local.y };
  const nearest = isFull(local.inventory) ? null : nearestTouching(game);
  if (nearest !== null) {
    pickUp.perform(game, { id: nearest.id, ...at });
    return;
  }
  const slot = local.held;
  if (slot === null || (local.inventory[slot] ?? null) === null) return;
  drop.perform(game, { slot, ...at });
}
