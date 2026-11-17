import { omit, sumBy } from "lodash-es";
import { z } from "zod";
import type { ItemLoot } from "./loot.js";
import type { Sound } from "./sound.js";

/** An item's id, as a player reports it. */
export const ItemId = z.string().min(1).max(32);

/** An item's uses left, as a carried or lying item keeps them. */
export const UsesLeft = z.number().int().min(0).max(10_000);

/**
 * What one item keeps of its own, carried or lying, past its uses: whether a walkie talkie is
 * switched on, say, or which song a radio plays. A few small flat values, which the item's own
 * content reads and writes. By convention `on: true` is an item switched on, which the toolbar
 * and the ground show.
 */
export const ItemState = z
  .record(z.string().min(1).max(16), z.union([z.number(), z.boolean()]))
  .refine((state) => Object.keys(state).length <= 8);
export type ItemState = z.infer<typeof ItemState>;

/** Whether `state` is that of an item switched on. */
export const isOn = (state: ItemState | undefined): boolean =>
  state?.on === true;

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /** The glyph the item is drawn with. */
  readonly emoji: string;
  /**
   * The glyph one of it is drawn with given the state it keeps, wherever it is drawn: a pocketball
   * full or empty, say. Always `emoji` when left out.
   */
  readonly emojiFor?: (state: ItemState | undefined) => string;
  /**
   * A CSS colour its glyph glows and glints in, wherever it is drawn, to tell a precious item from
   * a plain one sharing its glyph; none when left out.
   */
  readonly glint?: string;
  /**
   * Whether one lying in the world is perceived only while it lies in deepdark: out of it, nobody
   * sees or picks it up. Carried, it is perceived as any item is. Anywhere when left out.
   */
  readonly onlyInDeepdark?: boolean;
  /** What every client near it hears when it is dropped, if anything. */
  readonly drop?: Sound;
  /** What every client near it hears as its last use is spent and it is gone, if anything. */
  readonly breaks?: Sound;
  /** How heavy it is to carry, in pounds; nothing when left out. */
  readonly weight?: number;
  /** How many uses a new one has; unlimited when left out. */
  readonly uses?: number;
  /** How likely the world is to lay it as loot; never when left out. */
  readonly loot?: ItemLoot;
}

/**
 * An item as a player carries it: its definition, the uses it has left once it has spent some,
 * and its own state, if it keeps any. One that has spent none has all its uses.
 */
export interface CarriedItem extends ItemDefinition {
  readonly left?: number;
  readonly state?: ItemState;
}

/** One item per slot; items do not stack. */
export type Inventory = (CarriedItem | null)[];

/** The glyph `item` is drawn with, keeping `state`: its own for that state, or its usual one. */
export const glyphOf = (
  item: Pick<ItemDefinition, "emoji" | "emojiFor">,
  state: ItemState | undefined,
): string => item.emojiFor?.(state) ?? item.emoji;

/** The uses `item` has left; null for an item whose uses are unlimited. */
export function usesLeft(item: CarriedItem): number | null {
  if (item.uses === undefined) return null;
  return item.left ?? item.uses;
}

/**
 * `item` with `left` uses left: as new when `left` is all its uses, or not given. Its state stays
 * as it is.
 */
export function carried(item: CarriedItem, left?: number): CarriedItem {
  const full = left === undefined || left === item.uses;
  if (item.left === undefined && full) return item;
  const definition = omit(item, "left");
  return full ? definition : { ...definition, left };
}

/** `item` keeping `state` of its own; none when `state` is undefined or empty. */
export function withState(
  item: CarriedItem,
  state: ItemState | undefined,
): CarriedItem {
  const none = state === undefined || Object.keys(state).length === 0;
  if (none && item.state === undefined) return item;
  const rest = omit(item, "state");
  return none ? rest : { ...rest, state };
}

/** What every item in `inventory` weighs together, in pounds. */
export const carriedWeight = (inventory: Inventory): number =>
  sumBy(inventory, (item) => item?.weight ?? 0);

export function createInventory(slotCount: number): Inventory {
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new RangeError("Inventory size must be a positive integer.");
  }
  return Array.from({ length: slotCount }, () => null);
}

function requireSlot(inventory: Inventory, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length)
    throw new RangeError("Invalid inventory slot.");
}

/** Puts `item` in the first empty slot. Returns whether it fit. */
export function addItem(inventory: Inventory, item: CarriedItem): boolean {
  const index = inventory.indexOf(null);
  if (index === -1) return false;
  inventory[index] = item;
  return true;
}

/** Puts `item` in `slot`, which must exist and be empty. */
export function placeItem(
  inventory: Inventory,
  slot: number,
  item: CarriedItem,
): void {
  requireSlot(inventory, slot);
  if (inventory[slot] !== null)
    throw new RangeError(`Inventory slot ${String(slot)} is taken.`);
  inventory[slot] = item;
}

/** Empties `slot`, returning what it held, or null if it was empty. */
export function removeItem(
  inventory: Inventory,
  slot: number,
): CarriedItem | null {
  requireSlot(inventory, slot);
  const item = inventory[slot] ?? null;
  inventory[slot] = null;
  return item;
}

/** Whether every slot holds an item. */
export function isFull(inventory: Inventory): boolean {
  return !inventory.includes(null);
}

/** The slot whose item is held; null holds nothing. */
export type HeldSlot = number | null;

/**
 * The slot held after pressing slot number `slot`: the pressed slot, even when it is empty, or
 * nothing when the inventory has no such slot.
 */
export function selectSlot(inventory: Inventory, slot: number): HeldSlot {
  return Number.isInteger(slot) && slot >= 0 && slot < inventory.length
    ? slot
    : null;
}

/**
 * The slot held after stepping `by` slots from `held`, wrapping round the inventory: empty slots
 * count, as a number key can select them too. From holding nothing, a step forward holds the first
 * slot and a step back the last. An inventory without slots holds nothing.
 */
export function cycleSlot(
  inventory: Inventory,
  held: HeldSlot,
  by: number,
): HeldSlot {
  const count = inventory.length;
  if (count === 0) return null;
  if (by === 0) return held;
  const from = held ?? (by > 0 ? -1 : 0);
  return (((from + by) % count) + count) % count;
}

/** The item in the selected slot, or null when holding nothing. */
export function heldItem(
  inventory: Inventory,
  selected: HeldSlot,
): CarriedItem | null {
  if (selected === null) return null;
  return inventory[selected] ?? null;
}
