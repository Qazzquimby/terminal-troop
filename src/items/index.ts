import { heldItem, SHOVEL } from "../sim/index.js";
import type { Session } from "../sim/index.js";
import type { ItemBehaviour } from "./behaviour.js";
import type { ShovelConfig } from "./shovel.js";
import { createShovel } from "./shovel.js";

export type { ItemBehaviour } from "./behaviour.js";
export type { ShovelConfig } from "./shovel.js";

/** Every usable item, by item id. */
export type ItemBehaviours = ReadonlyMap<string, ItemBehaviour>;

/** The usable items of `config`, keyed by item id. */
export function createItems(config: {
  readonly shovel: ShovelConfig;
}): ItemBehaviours {
  return new Map([[SHOVEL.id, createShovel(config.shovel)]]);
}

/**
 * Uses the local player's held item at `now`, if it is usable and off cooldown. Returns
 * whether a use started.
 */
export function useHeldItem(
  game: Session,
  now: number,
  behaviours: ItemBehaviours,
): boolean {
  const { local } = game;
  const stack = heldItem(local.inventory, local.held);
  if (stack === null) return false;
  const behaviour = behaviours.get(stack.item.id);
  if (behaviour === undefined) return false;
  if (local.use !== null && now - local.use.startedAt < behaviour.cooldownMs)
    return false;
  const use = behaviour.use(game, now);
  if (use === null) return false;
  local.use = use;
  return true;
}
