import { addItem, createInventory, registerItem } from "../sim/index.js";
import type { Inventory, ItemBehaviour, Session } from "../sim/index.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel, SHOVEL } from "./shovel.js";

export type { ShovelConfig } from "./shovel.js";

/** Number keys 1-9 select these slots. */
const SLOT_COUNT = 9;

/** The id of every usable item. */
type ItemId = typeof SHOVEL.id;

/** Every player starts holding a shovel in the first slot. */
function startingInventory(): Inventory {
  const inventory = createInventory(SLOT_COUNT);
  addItem(inventory, SHOVEL, 1);
  return inventory;
}

/** The usable items of `config`, each registered with a session under its item id. */
export function createItems(config: { readonly shovel: ShovelConfig }) {
  const behaviours: ReadonlyMap<ItemId, ItemBehaviour> = new Map([
    [SHOVEL.id, createShovel(config.shovel)],
  ]);
  return {
    /** Registers what every usable item does with `game`, and stocks its local player's inventory. */
    register(game: Session): void {
      behaviours.forEach((behaviour, id) => {
        registerItem(game, id, behaviour);
      });
      game.local.inventory = startingInventory();
    },
  };
}
