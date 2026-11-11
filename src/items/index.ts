import { addItem, registerItem } from "../sim/index.js";
import type { ItemBehaviour, Session } from "../sim/index.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel, SHOVEL } from "./shovel.js";

export type { ShovelConfig } from "./shovel.js";

/** The id of every usable item. */
type ItemId = typeof SHOVEL.id;

/** The usable items of `config`, each registered with a session under its item id. */
export function createItems(config: { readonly shovel: ShovelConfig }) {
  const behaviours: ReadonlyMap<ItemId, ItemBehaviour> = new Map([
    [SHOVEL.id, createShovel(config.shovel)],
  ]);
  return {
    /** Registers what every usable item does with `game`, and puts a shovel in its local player's first slot. */
    register(game: Session): void {
      behaviours.forEach((behaviour, id) => {
        registerItem(game, id, behaviour);
      });
      addItem(game.local.inventory, SHOVEL, 1);
    },
  };
}
