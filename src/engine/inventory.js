/**
 * @typedef {Object} ItemDefinition
 * @property {string} id
 * @property {string} name
 * @property {number} maxStack
 */

/**
 * @typedef {Object} InventoryStack
 * @property {ItemDefinition} item
 * @property {number} quantity
 */

/** @param {number} slotCount */
export function createInventory(slotCount) {
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    throw new RangeError("Inventory size must be a positive integer.");
  }
  return Array.from({ length: slotCount }, () => /** @type {InventoryStack|null} */ (null));
}

function requireQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError("Quantity must be a positive integer.");
  }
}

/**
 * @param {(InventoryStack|null)[]} inventory
 * @param {ItemDefinition} item
 * @param {number} quantity
 * @returns {number} Quantity that did not fit.
 */
export function addItem(inventory, item, quantity) {
  requireQuantity(quantity);
  requireQuantity(item.maxStack);

  let remaining = quantity;
  for (const stack of inventory) {
    if (!stack || stack.item.id !== item.id) continue;
    const added = Math.min(remaining, stack.item.maxStack - stack.quantity);
    stack.quantity += added;
    remaining -= added;
    if (remaining === 0) return 0;
  }

  for (let index = 0; index < inventory.length && remaining > 0; index++) {
    if (inventory[index]) continue;
    const added = Math.min(remaining, item.maxStack);
    inventory[index] = { item, quantity: added };
    remaining -= added;
  }

  return remaining;
}

/**
 * @param {(InventoryStack|null)[]} inventory
 * @param {number} slot
 * @param {number} quantity
 * @returns {number} Quantity removed.
 */
export function removeItem(inventory, slot, quantity) {
  requireQuantity(quantity);
  if (!Number.isInteger(slot) || slot < 0 || slot >= inventory.length) {
    throw new RangeError("Invalid inventory slot.");
  }

  const stack = inventory[slot];
  if (!stack) return 0;

  const removed = Math.min(quantity, stack.quantity);
  stack.quantity -= removed;
  if (stack.quantity === 0) inventory[slot] = null;
  return removed;
}
