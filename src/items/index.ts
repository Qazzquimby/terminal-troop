import { addItem, registerItem } from "../sim/index.js";
import type { ItemBehaviour, ItemDefinition, Session } from "../sim/index.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel, SHOVEL } from "./shovel.js";

export type { ShovelConfig } from "./shovel.js";

/** The id of every usable item. */
type ItemId = typeof SHOVEL.id;

/** The usable items of `config`, each registered with a session under its item id. */
export function createItems(config: { readonly shovel: ShovelConfig }) {
  const usable: readonly (readonly [
    ItemDefinition & { readonly id: ItemId },
    ItemBehaviour,
  ])[] = [[SHOVEL, createShovel(config.shovel)]];
  return {
    /** Registers what every usable item does with `game`, and puts a shovel in its local player's first slot. */
    register(game: Session): void {
      for (const [item, behaviour] of usable)
        registerItem(game, item, behaviour);
      addItem(game.local.inventory, SHOVEL, 1);
    },
  };
}
