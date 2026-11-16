import { z } from "zod";
import {
  defineAction,
  effect,
  give,
  removeFromWorld,
  spawn,
  stateAt,
  take,
  usesAt,
} from "./actions.js";
import type { WorldEntity } from "./entities.js";
import {
  ITEM_TAG,
  registerEntityType,
  removeEntity,
  spawnEntity,
} from "./entities.js";
import { hasRoom, isReaching, itemIn } from "./inventories.js";
import { isFull, isOn, ItemId, ItemState, UsesLeft } from "./inventory.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { controlHeldItem } from "./use.js";
import { useVehicle } from "./vehicle.js";

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

/**
 * A lying item's state: which item it is, the uses it has left once it has spent some, and its
 * own state once it keeps any.
 */
const WorldItemData = z.object({
  item: ItemId,
  left: UsesLeft.optional(),
  state: ItemState.optional(),
});
type WorldItemData = z.infer<typeof WorldItemData>;

/** The colour of the light an item switched on shows. */
const ON_LIGHT = "#7dff8a";

/** Seconds between one glinting item's glints, and how long each lasts. */
const GLINT_EVERY = 1.8;
const GLINT_FOR = 0.35;

/**
 * A glinting item's sparkle: a four-pointed star at its upper edge that swells and fades for a
 * moment every so often, each item at a moment set by where it lies, so a hoard does not flash
 * as one.
 */
function drawGlint(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  radius: number,
  colour: string,
  now: number,
): void {
  const offset = (entity.x * 0.013 + entity.y * 0.007) % GLINT_EVERY;
  const phase = (now / 1000 + offset) % GLINT_EVERY;
  if (phase > GLINT_FOR) return;
  const size = radius * 0.6 * Math.sin((phase / GLINT_FOR) * Math.PI);
  const x = entity.x + radius * 0.5;
  const y = entity.y - radius * 0.5;
  const waist = size * 0.2;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x, y - size);
  ctx.lineTo(x + waist, y - waist);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x + waist, y + waist);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x - waist, y + waist);
  ctx.lineTo(x - size, y);
  ctx.lineTo(x - waist, y - waist);
  ctx.closePath();
  ctx.fill();
}

/**
 * Registers the kind items lie in the world as, once a session has any items; each is drawn as
 * its item's glyph, with a small pulsing light while it is switched on. Clients that register the
 * same content number it alike.
 */
export function registerWorldItems(game: Session): void {
  if (game.kindIds.has(WORLD_ITEM)) return;
  const { radius } = game.config.worldItems;
  registerEntityType(game, WORLD_ITEM, {
    radius,
    maxHealth: Infinity,
    collides: false,
    tags: [ITEM_TAG],
    data: WorldItemData,
    draw(ctx, entity, { item, state }, now, view) {
      const glyph = view.itemDefinitions.get(item)?.emoji;
      if (glyph === undefined) return;
      ctx.save();
      ctx.font = `${String(radius * 2)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const glint = view.itemDefinitions.get(item)?.glint;
      if (glint !== undefined) {
        ctx.shadowColor = glint;
        ctx.shadowBlur = radius * (0.6 + 0.3 * Math.sin((now / 1000) * 3));
      }
      ctx.fillText(glyph, entity.x, entity.y);
      ctx.shadowBlur = 0;
      if (glint !== undefined) drawGlint(ctx, entity, radius, glint, now);
      if (isOn(state)) {
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin((now / 1000) * Math.PI * 2);
        ctx.fillStyle = ON_LIGHT;
        ctx.beginPath();
        ctx.arc(entity.x + radius, entity.y - radius, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  });
}

/**
 * A lying item's state: `item` with `left` uses left, or all its uses when left out, keeping
 * `state` of its own, if any.
 */
const lyingData = (
  item: string,
  left?: number | null,
  state?: ItemState,
): WorldItemData => ({
  item,
  ...(left !== undefined && left !== null && { left }),
  ...(state !== undefined && Object.keys(state).length > 0 && { state }),
});

/** Whether items can lie in `game`'s world: it has any items registered. */
export const itemsCanLie = (game: Session): boolean =>
  game.kindIds.has(WORLD_ITEM);

/**
 * Lays the item `item` in the world at `at`, with `left` uses left, or all its uses when left
 * out, keeping `state` of its own, if any.
 */
export function spawnWorldItem(
  game: Session,
  at: Point,
  item: string,
  left?: number,
  state?: ItemState,
): WorldEntity {
  const data = lyingData(item, left, state);
  return spawnEntity(game, WORLD_ITEM, at.x, at.y, data);
}

/**
 * Sounds `item` landing at `at`, dropped by `by`, with its drop sound, if it has one: every client
 * near hears it, and one with a range makes a noise out to it. However an item comes to be
 * dropped, by a player letting go, a body falling or a monster laying it down, it sounds the same.
 * `by` may be left out only within an action, whose actor it is.
 */
export function soundDrop(
  game: Session,
  item: string,
  at: Point,
  by?: { readonly id: string },
): void {
  const sound = game.itemDefinitions.get(item)?.drop;
  if (sound !== undefined) effect(game, { at, sound }, by);
}

/**
 * The item `entity` is, the uses it has left and its own state, if it is an item lying in the
 * world.
 */
export function lyingItem(
  game: Session,
  entity: WorldEntity,
): WorldItemData | null {
  if (entity.kind !== game.kindIds.get(WORLD_ITEM)) return null;
  const parsed = WorldItemData.safeParse(entity.data);
  return parsed.success ? parsed.data : null;
}

/**
 * As the host, leaves the lying item `entity` with `left` uses left, keeping its state; with none
 * left it is gone. Its snapshots carry that to every client. Returns whether it changed it.
 */
export function setLyingUses(
  game: Session,
  entity: WorldEntity,
  left: number,
): boolean {
  const lying = lyingItem(game, entity);
  if (!game.hosting || lying === null) return false;
  if (left <= 0) removeEntity(game, entity.id);
  else entity.data = lyingData(lying.item, left, lying.state);
  return true;
}

/** Whether `player`'s body touches `entity`. */
const touches = (player: Point & { radius: number }, entity: WorldEntity) =>
  Math.hypot(entity.x - player.x, entity.y - player.y) <=
  player.radius + entity.radius;

/**
 * A player's pickup of a lying item. The host takes it if the item still lies in the world, the
 * player's body touches it, and the host's record has room for it; it takes the item out of the
 * world, which its snapshots carry to everyone, then puts it in the player's first empty slot.
 * The player's own client shows it in its items at once, and does not reach for it again while
 * the host answers.
 */
export const pickUp = defineAction("pickUp", {
  input: z.object({ id: z.string().min(1).max(80) }),
  cooldown: (game) => game.config.worldItems.cooldown,
  check(game, player, { id }) {
    const entity = game.entities.get(id);
    if (entity === undefined || lyingItem(game, entity) === null) return false;
    return touches(player, entity) && hasRoom(game, player.id);
  },
  apply(game, player, { id }) {
    const entity = game.entities.get(id);
    const lying = entity === undefined ? null : lyingItem(game, entity);
    if (entity === undefined || lying === null) return;
    removeFromWorld(game, entity);
    give(game, player, lying.item, lying.left, lying.state);
  },
});

/**
 * A player letting go of the item in a slot, where it stands. The host takes it if its record has
 * an item in the slot: it takes the item out of the slot and lays it in the world there. The
 * player's own client shows it gone from its items at once, and every client hears it land, with
 * its item's drop sound, if it has one.
 */
export const drop = defineAction("drop", {
  input: z.object({ slot: z.number().int().min(0).max(63) }),
  cooldown: (game) => game.config.worldItems.dropCooldown,
  check: (game, player, { slot }) => itemIn(game, player.id, slot) !== null,
  apply(game, player, { slot }) {
    const left = usesAt(game, player, slot);
    const state = stateAt(game, player, slot);
    const item = take(game, player, slot);
    if (item === null) return;
    const at = { x: player.x, y: player.y };
    spawn(game, WORLD_ITEM, at, lyingData(item, left, state));
    soundDrop(game, item, at);
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
    if (!touches(local, entity)) continue;
    const distance = Math.hypot(entity.x - local.x, entity.y - local.y);
    if (distance >= nearestDistance) continue;
    nearest = entity;
    nearestDistance = distance;
  }
  return nearest;
}

/**
 * The local player's interaction: at the wheel, gets out. On foot, picks up the nearest lying
 * item it touches, if it has room; failing that gets in a vehicle beside it, if it may; otherwise
 * works the item it holds, if that item has a control.
 */
export function interact(game: Session): void {
  const { local } = game;
  if (local.ride !== null) {
    useVehicle(game);
    return;
  }
  const nearest = isFull(local.inventory) ? null : nearestTouching(game);
  if (nearest !== null) {
    pickUp.perform(game, { id: nearest.id });
    return;
  }
  if (useVehicle(game)) return;
  controlHeldItem(game);
}

/** The local player lets go of the item it holds, where it stands, if it holds any. */
export function dropHeld(game: Session): void {
  const slot = game.local.held;
  if (slot === null || (game.local.inventory[slot] ?? null) === null) return;
  drop.perform(game, { slot });
}
