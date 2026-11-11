import { heldItem, registerItem, SHOVEL } from "../sim/index.js";
import type { Session, UseRequest } from "../sim/index.js";
import type { ItemBehaviour } from "./behaviour.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel } from "./shovel.js";

export type { ShovelConfig } from "./shovel.js";

/** The usable items of `config`: what each does on the host, and how the local player uses it. */
export function createItems(config: { readonly shovel: ShovelConfig }) {
  const behaviours: ReadonlyMap<string, ItemBehaviour> = new Map([
    [SHOVEL.id, createShovel(config.shovel)],
  ]);
  return {
    /** Registers every usable item's effect with `game`. */
    register(game: Session): void {
      behaviours.forEach((behaviour, id) => {
        registerItem(game, id, behaviour);
      });
    },
    /**
     * Starts the local player's use of its held item at `now`, if it is usable and off
     * cooldown, and returns the request for the host to apply; null when no use started.
     */
    use(game: Session, now: number): UseRequest | null {
      const { local } = game;
      const stack = heldItem(local.inventory, local.held);
      if (stack === null) return null;
      const behaviour = behaviours.get(stack.item.id);
      if (behaviour === undefined) return null;
      if (
        local.use !== null &&
        now - local.use.startedAt < behaviour.cooldownMs
      )
        return null;
      local.use = behaviour.show(game, now);
      return {
        by: local.id,
        item: stack.item.id,
        x: local.x,
        y: local.y,
        aim: local.aim,
      };
    },
  };
}
