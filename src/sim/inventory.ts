import { z } from "zod";
import type { Sound } from "./sound.js";

/** An item's id, as a player reports it. */
export const ItemId = z.string().min(1).max(32);

export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /** The glyph the item is drawn with. */
  readonly emoji: string;
  /** What every client near it hears when it is dropped, if anything. */
  readonly drop?: Sound;
}

/** One item per slot; items do not stack. */
export type Inventory = (ItemDefinition | null)[];

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
export function addItem(inventory: Inventory, item: ItemDefinition): boolean {
  const index = inventory.indexOf(null);
  if (index === -1) return false;
  inventory[index] = item;
  return true;
}

/** Puts `item` in `slot`, which must exist and be empty. */
export function placeItem(
  inventory: Inventory,
  slot: number,
  item: ItemDefinition,
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
): ItemDefinition | null {
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
): ItemDefinition | null {
  if (selected === null) return null;
  return inventory[selected] ?? null;
}
