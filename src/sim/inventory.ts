export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  readonly maxStack: number;
  /** The glyph the item is drawn with. */
  readonly emoji: string;
}

/** @public */
export interface InventoryStack {
  readonly item: ItemDefinition;
  quantity: number;
}

export type Inventory = (InventoryStack | null)[];

export function createInventory(slotCount: number): Inventory {
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new RangeError("Inventory size must be a positive integer.");
  }
  return Array.from({ length: slotCount }, () => null);
}

function requireQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError("Quantity must be a positive integer.");
  }
}

/** @public Returns the quantity that did not fit. */
export function addItem(
  inventory: Inventory,
  item: ItemDefinition,
  quantity: number,
): number {
  requireQuantity(quantity);
  requireQuantity(item.maxStack);

  let remaining = quantity;
  for (const stack of inventory) {
    if (stack?.item.id !== item.id) continue;
    const added = Math.min(remaining, stack.item.maxStack - stack.quantity);
    stack.quantity += added;
    remaining -= added;
    if (remaining === 0) return 0;
  }

  for (let index = 0; index < inventory.length && remaining > 0; index++) {
    if (inventory[index] !== null) continue;
    const added = Math.min(remaining, item.maxStack);
    inventory[index] = { item, quantity: added };
    remaining -= added;
  }

  return remaining;
}

/** Puts a stack of `quantity` `item` in `slot`, which must exist and be empty. */
export function placeItem(
  inventory: Inventory,
  slot: number,
  item: ItemDefinition,
  quantity: number,
): void {
  requireQuantity(quantity);
  if (quantity > item.maxStack)
    throw new RangeError(`More ${item.id} than one stack holds.`);
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length)
    throw new RangeError("Invalid inventory slot.");
  if (inventory[slot] !== null)
    throw new RangeError(`Inventory slot ${String(slot)} is taken.`);
  inventory[slot] = { item, quantity };
}

/** @public Returns the quantity removed. */
export function removeItem(
  inventory: Inventory,
  slot: number,
  quantity: number,
): number {
  requireQuantity(quantity);
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length) {
    throw new RangeError("Invalid inventory slot.");
  }

  const stack = inventory[slot];
  if (stack === null || stack === undefined) return 0;

  const removed = Math.min(quantity, stack.quantity);
  stack.quantity -= removed;
  if (stack.quantity === 0) inventory[slot] = null;
  return removed;
}

/** The slot whose item is held; null holds nothing. */
export type HeldSlot = number | null;

/**
 * The slot held after pressing slot number `slot` while holding `held`: the pressed slot, even
 * when it is empty, unless the inventory has no such slot.
 */
export function selectSlot(
  inventory: Inventory,
  held: HeldSlot,
  slot: number,
): HeldSlot {
  return Number.isInteger(slot) && slot >= 0 && slot < inventory.length
    ? slot
    : held;
}

/** The stack in the selected slot, or null when holding nothing. */
export function heldItem(
  inventory: Inventory,
  selected: HeldSlot,
): InventoryStack | null {
  if (selected === null) return null;
  return inventory[selected] ?? null;
}
