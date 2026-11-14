import { effect, spendUses } from "./actions.js";
import type { WorldEntity } from "./entities.js";
import { heldSlot, itemsOf } from "./inventories.js";
import { usesLeft } from "./inventory.js";
import type { ItemState } from "./inventory.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { lyingItem, setLyingUses } from "./world-items.js";

/** Where one item is: in a player's slot, or lying in the world. */
type ItemPlace =
  | {
      readonly carrier: Player;
      readonly slot: number;
      /** Whether its carrier holds it, rather than carrying it in another slot. */
      readonly held: boolean;
    }
  | { readonly lying: WorldEntity };

/** One item somewhere in the world, as this client knows it. */
export interface ItemInstance {
  readonly item: string;
  /** Where it is now: its carrier's spot, or where it lies. */
  readonly at: Point;
  /** The uses it has left; null for unlimited. */
  readonly left: number | null;
  /** What it keeps of its own, if anything. */
  readonly state: ItemState | undefined;
  readonly place: ItemPlace;
}

/** Whose noise `instance` makes: its carrier's, or its own as it lies there. */
export const makerOf = (instance: ItemInstance): { readonly id: string } =>
  "carrier" in instance.place ? instance.place.carrier : instance.place.lying;

/**
 * Every item `item` in the world, carried by any player, as the host keeps their items, or lying
 * about; every item of any kind when `item` is left out.
 */
export function itemInstances(game: Session, item?: string): ItemInstance[] {
  const found: ItemInstance[] = [];
  for (const carrier of game.players.values()) {
    const held = heldSlot.get(carrier);
    itemsOf(game, carrier.id).forEach((carried, slot) => {
      if (carried === null || (item !== undefined && carried.id !== item))
        return;
      found.push({
        item: carried.id,
        at: { x: carrier.x, y: carrier.y },
        left: usesLeft(carried),
        state: carried.state,
        place: { carrier, slot, held: held === slot },
      });
    });
  }
  for (const entity of game.entities.values()) {
    const lying = lyingItem(game, entity);
    if (lying === null || (item !== undefined && lying.item !== item)) continue;
    const definition = game.itemDefinitions.get(lying.item);
    found.push({
      item: lying.item,
      at: { x: entity.x, y: entity.y },
      left: lying.left ?? definition?.uses ?? null,
      state: lying.state,
      place: { lying: entity },
    });
  }
  return found;
}

/**
 * As the host, spends `amount` of `instance`'s uses, wherever it is, outside any action: an item
 * that spends its last use is gone, with its breaking sound. Does nothing to an item whose uses
 * are unlimited. Returns the uses left; null when it spent none.
 */
export function spendInstanceUses(
  game: Session,
  instance: ItemInstance,
  amount = 1,
): number | null {
  const { place } = instance;
  if (!game.hosting || instance.left === null) return null;
  if (!("lying" in place))
    return spendUses(game, place.carrier, place.slot, amount);
  const left = Math.max(0, instance.left - amount);
  // Its breaking sound goes first, while it still lies there to be tagged as its maker.
  const breaks = game.itemDefinitions.get(instance.item)?.breaks;
  if (left === 0 && breaks !== undefined)
    effect(game, { at: instance.at, sound: breaks }, place.lying);
  return setLyingUses(game, place.lying, left) ? left : null;
}
