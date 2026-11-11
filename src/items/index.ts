import { registerItem, SHOVEL } from "../sim/index.js";
import type { ItemBehaviour, Session } from "../sim/index.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel } from "./shovel.js";

export type { ShovelConfig } from "./shovel.js";

/** The usable items of `config`, each registered with a session under its item id. */
export function createItems(config: { readonly shovel: ShovelConfig }) {
  const behaviours: ReadonlyMap<string, ItemBehaviour> = new Map([
    [SHOVEL.id, createShovel(config.shovel)],
  ]);
  return {
    /** Registers what every usable item does with `game`. */
    register(game: Session): void {
      behaviours.forEach((behaviour, id) => {
        registerItem(game, id, behaviour);
      });
    },
  };
}
