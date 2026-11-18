import { z } from "zod";
import { upright } from "../lib/upright/index.js";
import {
  defineAction,
  effect,
  give,
  removeFromWorld,
  spawn,
  spendUses,
  stateAt,
  take,
  usesAt,
} from "./actions.js";
import { perceives } from "./bodies.js";
import type { PosedItem, WorldEntity } from "./entities.js";
import {
  ITEM_TAG,
  registerEntityType,
  removeEntity,
  spawnEntity,
} from "./entities.js";
import { hasRoom, isReaching, itemIn, setItemState } from "./inventories.js";
import { glyphOf, isFull, isOn } from "./inventory.js";
import type { ItemState } from "./inventory.js";
import type { ItemInstance } from "./item-instances.js";
import { lyingData, lyingItem, WORLD_ITEM, WorldItemData } from "./lying.js";
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
  entity: Point,
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
    castsShadow: false,
    tags: [ITEM_TAG],
    data: WorldItemData,
    onlyInDeepdark: (_entity, { item }, view) =>
      view.itemDefinitions.get(item)?.onlyInDeepdark === true,
    draw(ctx, entity, lying, now, view) {
      drawLying(ctx, entity, lying, now, view);
    },
  });
}

/**
 * Draws `posed` lying at `at` as any lying item of it is drawn: its glyph at a lying item's size,
 * glinting if it glints, with a small pulsing light while it is switched on. For whatever passes
 * itself off as one, so it looks no different.
 */
export function drawLying(
  ctx: CanvasRenderingContext2D,
  at: Point,
  posed: PosedItem,
  now: number,
  view: Session,
): void {
  const { item, state } = posed;
  const { radius } = view.config.worldItems;
  const definition = view.itemDefinitions.get(item);
  if (definition === undefined) return;
  const glyph = glyphOf(definition, state);
  ctx.save();
  ctx.font = `${String(radius * 2)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const { glint } = definition;
  if (glint !== undefined) {
    ctx.shadowColor = glint;
    ctx.shadowBlur = radius * (0.6 + 0.3 * Math.sin((now / 1000) * 3));
  }
  upright(ctx, at, () => {
    ctx.fillText(glyph, at.x, at.y);
  });
  ctx.shadowBlur = 0;
  if (glint !== undefined) drawGlint(ctx, at, radius, glint, now);
  if (isOn(state)) {
    ctx.globalAlpha = 0.6 + 0.4 * Math.sin((now / 1000) * Math.PI * 2);
    ctx.fillStyle = ON_LIGHT;
    ctx.beginPath();
    ctx.arc(at.x + radius, at.y - radius, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Whether items can lie in `game`'s world: it has any items registered. */
export const itemsCanLie = (game: Session): boolean =>
  game.kindIds.has(WORLD_ITEM);

/**
 * Lays the item `item` in the world at `at`, with `left` uses left, or all its uses when left
 * out, keeping `state` of its own, if any, pointing `facing` radians, 0 when left out.
 */
export function spawnWorldItem(
  game: Session,
  at: Point,
  item: string,
  left?: number,
  state?: ItemState,
  facing?: number,
): WorldEntity {
  const data = lyingData(item, left, state, facing);
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
 * The item `entity` seems to be to a body looking at it: the item it is, lying in the world, or
 * the one it passes itself off as; null for neither.
 */
export function seemsItem(
  game: Session,
  entity: WorldEntity,
): PosedItem | null {
  return (
    lyingItem(game, entity) ??
    game.entityTypes.get(entity.kind)?.posedItem(entity) ??
    null
  );
}

/**
 * As the host, leaves the lying item `entity` with `left` uses left, keeping its state; with none
 * left it is gone. Its snapshots carry that to every client. Returns whether it changed it.
 */
function setLyingUses(
  game: Session,
  entity: WorldEntity,
  left: number,
): boolean {
  const lying = lyingItem(game, entity);
  if (!game.hosting || lying === null) return false;
  if (left <= 0) removeEntity(game, entity.id);
  else entity.data = lyingData(lying.item, left, lying.state, lying.facing);
  return true;
}

/**
 * As the host, leaves the lying item `entity` keeping `state` of its own, none when undefined,
 * as it was otherwise. Its snapshots carry that to every client. Returns whether it changed it.
 */
function setLyingState(
  game: Session,
  entity: WorldEntity,
  state: ItemState | undefined,
): boolean {
  const lying = lyingItem(game, entity);
  if (!game.hosting || lying === null) return false;
  entity.data = lyingData(lying.item, lying.left, state, lying.facing);
  return true;
}

/**
 * As the host, spends `amount` of `instance`'s uses, wherever it is, outside any action: an item
 * that spends its last use is gone, with its breaking sound. Does nothing to an item whose uses
 * are unlimited. Returns the uses left; null when it spent none.
 */
export function spendInstanceUses(
  game: Session,
  instance: ItemInstance,
  amount = 1,
): number | null {
  const { place } = instance;
  if (!game.hosting || instance.left === null) return null;
  if (!("lying" in place))
    return spendUses(game, place.carrier, place.slot, amount);
  const left = Math.max(0, instance.left - amount);
  // Its breaking sound goes first, while it still lies there to be tagged as its maker.
  const breaks = game.itemDefinitions.get(instance.item)?.breaks;
  if (left === 0 && breaks !== undefined)
    effect(game, { at: instance.at, sound: breaks }, place.lying);
  return setLyingUses(game, place.lying, left) ? left : null;
}

/**
 * As the host, leaves `instance` keeping `state` of its own, none when undefined, wherever it is,
 * outside any action. Returns whether it did.
 */
export function setInstanceState(
  game: Session,
  instance: ItemInstance,
  state: ItemState | undefined,
): boolean {
  const { place } = instance;
  if (!game.hosting) return false;
  if ("lying" in place) return setLyingState(game, place.lying, state);
  return setItemState(game, place.carrier.id, place.slot, instance.item, state);
}

/**
 * How far apart, in pixels, two bodies may stand and still touch: one that collides, as a body
 * posing as an item does, is pushed off to just past touching.
 */
const TOUCH_SLACK = 1;

/** Whether `player`'s body touches `entity`. */
const touches = (player: Point & { radius: number }, entity: WorldEntity) =>
  Math.hypot(entity.x - player.x, entity.y - player.y) <=
  player.radius + entity.radius + TOUCH_SLACK;

/**
 * A player's pickup of a lying item. The host takes it if the item still lies in the world, the
 * player's body touches it, and the host's record has room for it; it takes the item out of the
 * world, which its snapshots carry to everyone, then puts it in the player's first empty slot.
 * The player's own client shows it in its items at once, and does not reach for it again while
 * the host answers. Reaching for a body that only poses as an item takes nothing: the body's kind
 * says what the grab does to it, as a mimic springs.
 */
export const pickUp = defineAction("pickUp", {
  input: z.object({ id: z.string().min(1).max(80) }),
  cooldown: (game) => game.config.worldItems.cooldown,
  check(game, player, { id }) {
    const entity = game.entities.get(id);
    if (entity === undefined || seemsItem(game, entity) === null) return false;
    return (
      perceives(game, player.id, id) &&
      touches(player, entity) &&
      hasRoom(game, player.id)
    );
  },
  apply(game, player, { id }) {
    const entity = game.entities.get(id);
    if (entity === undefined) return;
    const lying = lyingItem(game, entity);
    if (lying === null) {
      game.entityTypes.get(entity.kind)?.grabbed(entity, player, game);
      return;
    }
    removeFromWorld(game, entity);
    give(game, player, lying.item, lying.left, lying.state);
  },
});

/**
 * A player letting go of the item in a slot, where it stands. The host takes it if its record has
 * an item in the slot: it takes the item out of the slot and lays it in the world there, as it
 * was, pointing the way the player faced as it let go, as it sends it. The
 * player's own client shows it gone from its items at once, and every client hears it land, with
 * its item's drop sound, if it has one.
 */
export const drop = defineAction("drop", {
  input: z.object({
    slot: z.number().int().min(0).max(63),
    aim: z.number().optional(),
  }),
  cooldown: (game) => game.config.worldItems.dropCooldown,
  check: (game, player, { slot }) => itemIn(game, player.id, slot) !== null,
  apply(game, player, { slot, aim = player.aim }) {
    const left = usesAt(game, player, slot);
    const state = stateAt(game, player, slot);
    const item = take(game, player, slot);
    if (item === null) return;
    const at = { x: player.x, y: player.y };
    spawn(game, WORLD_ITEM, at, lyingData(item, left, state, aim));
    soundDrop(game, item, at);
  },
});

/**
 * The lying item nearest the local player that its body touches and perceives, if any, or a body
 * posing as one. One it does not perceive, as dark scrap out of deepdark, is not there to it: the host would refuse it,
 * and it must not shadow a visible item lying under it (#429).
 */
function nearestTouching(game: Session): WorldEntity | null {
  const { local } = game;
  let nearest: WorldEntity | null = null;
  let nearestDistance = Infinity;
  for (const entity of game.entities.values()) {
    if (seemsItem(game, entity) === null || isReaching(game, entity.id))
      continue;
    if (!touches(local, entity) || !perceives(game, local.id, entity.id))
      continue;
    const distance = Math.hypot(entity.x - local.x, entity.y - local.y);
    if (distance >= nearestDistance) continue;
    nearest = entity;
    nearestDistance = distance;
  }
  return nearest;
}

/**
 * The lying item the local player's interaction would pick up now, if any: the nearest it touches,
 * on foot and with room for it. `interact` picks up exactly this, so what is shown as the target
 * and what is taken never disagree.
 */
export function pickupTarget(game: Session): WorldEntity | null {
  const { local } = game;
  if (local.ride !== null || isFull(local.inventory)) return null;
  return nearestTouching(game);
}

/** The local player lets go of the item it holds, where it stands, if it holds any. */
export function dropHeld(game: Session): void {
  const slot = game.local.held;
  if (slot === null || (game.local.inventory[slot] ?? null) === null) return;
  drop.perform(game, { slot, aim: game.local.aim });
}
