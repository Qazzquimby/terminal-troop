import { addItem, createInventory, registerItem } from "../sim/index.js";
import type { Inventory, ItemBehaviour, Session } from "../sim/index.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel, SHOVEL } from "./shovel.js";
import { createScrap } from "./scrap.js";
import type { ScrapConfig } from "./scrap.js";

export type { ScrapConfig } from "./scrap.js";
export { SCRAP } from "./scrap.js";
export type { ShovelConfig } from "./shovel.js";

/** Number keys select these slots. */
const SLOT_COUNT = 6;

/** The id of every usable item. */
type ItemId = typeof SHOVEL.id;

/** Every player starts holding a shovel in the first slot. */
function startingInventory(): Inventory {
  const inventory = createInventory(SLOT_COUNT);
  addItem(inventory, SHOVEL);
  return inventory;
}

/** The usable items of `config`, each registered with a session under its item id. */
export function createItems(config: {
  readonly shovel: ShovelConfig;
  readonly scrap: ScrapConfig;
}) {
  const behaviours: ReadonlyMap<ItemId, ItemBehaviour> = new Map([
    [SHOVEL.id, createShovel(config.shovel)],
  ]);
  const scrap = createScrap(config.scrap);
  return {
    /** Registers what every usable item does with `game`, stocks its local player's inventory, and registers ground scrap. */
    register(game: Session): void {
      behaviours.forEach((behaviour, id) => {
        registerItem(game, id, behaviour);
      });
      game.local.inventory = startingInventory();
      scrap.register(game);
    },
    /** Spawns the ground scrap a new world starts with. */
    populate(game: Session): void {
      scrap.populate(game);
    },
  };
}
