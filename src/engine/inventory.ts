export interface ItemDefinition {
  readonly id: string;
  readonly name: string;
  readonly maxStack: number;
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
