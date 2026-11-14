import { omit, sumBy } from "lodash-es";
import { z } from "zod";
import type { ItemLoot } from "./loot.js";
import type { Sound } from "./sound.js";

/** An item's id, as a player reports it. */
export const ItemId = z.string().min(1).max(32);

/** An item's uses left, as a carried or lying item keeps them. */
export const UsesLeft = z.number().int().min(0).max(10_000);

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /** The glyph the item is drawn with. */
  readonly emoji: string;
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
 * An item as a player carries it: its definition, and the uses it has left once it has spent
 * some. One that has spent none has all its uses.
 */
export interface CarriedItem extends ItemDefinition {
  readonly left?: number;
}

/** One item per slot; items do not stack. */
export type Inventory = (CarriedItem | null)[];

/** The uses `item` has left; null for an item whose uses are unlimited. */
export function usesLeft(item: CarriedItem): number | null {
  if (item.uses === undefined) return null;
  return item.left ?? item.uses;
}

/** `item` with `left` uses left: as new when `left` is all its uses, or not given. */
export function carried(item: CarriedItem, left?: number): CarriedItem {
  const full = left === undefined || left === item.uses;
  if (item.left === undefined && full) return item;
  const definition = omit(item, "left");
  return full ? definition : { ...definition, left };
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

/** The item in the selected slot, or null when holding nothing. */
export function heldItem(
  inventory: Inventory,
  selected: HeldSlot,
): CarriedItem | null {
  if (selected === null) return null;
  return inventory[selected] ?? null;
}
