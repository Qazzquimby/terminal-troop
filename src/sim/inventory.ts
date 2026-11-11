export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  /** The glyph the item is drawn with. */
  readonly emoji: string;
}

export type Inventory = (ItemDefinition | null)[];

export function createInventory(slotCount: number): Inventory {
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new RangeError("Inventory size must be a positive integer.");
  }
  return Array.from({ length: slotCount }, () => null);
}

/** @public Puts `item` in the first empty slot. Returns whether it fit. */
export function addItem(inventory: Inventory, item: ItemDefinition): boolean {
  const index = inventory.indexOf(null);
  if (index === -1) return false;
  inventory[index] = item;
  return true;
}

/** @public Empties `slot`, returning what it held, or null if it was empty. */
export function removeItem(
  inventory: Inventory,
  slot: number,
): ItemDefinition | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length) {
    throw new RangeError("Invalid inventory slot.");
  }
  const item = inventory[slot] ?? null;
  inventory[slot] = null;
  return item;
}

/** The slot whose item is held; null holds nothing. */
export type HeldSlot = number | null;

/** Pressing a slot number selects it, even when the slot is empty. */
export function selectSlot(inventory: Inventory, slot: HeldSlot): HeldSlot {
  if (slot === null) return null;
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length) {
    throw new RangeError("Invalid inventory slot.");
  }
  return slot;
}

/** The item in the selected slot, or null when holding nothing. */
export function heldItem(
  inventory: Inventory,
  selected: HeldSlot,
): ItemDefinition | null {
  if (selected === null) return null;
  return inventory[selected] ?? null;
}

/** The glyph drawn for the held item, or null when holding nothing. */
export function heldEmoji(
  inventory: Inventory,
  selected: HeldSlot,
): string | null {
  return heldItem(inventory, selected)?.emoji ?? null;
}
