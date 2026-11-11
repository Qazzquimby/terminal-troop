import type { Inventory, ItemDefinition } from "./inventory.js";
import { addItem, createInventory } from "./inventory.js";

/** Number keys 1-9 select these slots. */
const SLOT_COUNT = 9;

export const SHOVEL: ItemDefinition = {
  id: "shovel",
  name: "Shovel",
  maxStack: 1,
  emoji: "🪏",
};

/** Every player starts holding a shovel in the first slot. */
export function startingInventory(): Inventory {
  const inventory = createInventory(SLOT_COUNT);
  addItem(inventory, SHOVEL, 1);
  return inventory;
}
