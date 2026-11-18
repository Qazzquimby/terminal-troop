import type { WorldEntity } from "./entities.js";
import { heldItemOf, heldSlot, heldSlotOf, itemsOf } from "./inventories.js";
import { usesLeft } from "./inventory.js";
import type { CarriedItem, ItemState } from "./inventory.js";
import { lyingItem } from "./lying.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/** Where one item is: in a player's slot, or lying in the world. */
type ItemPlace =
  | {
      readonly carrier: Player;
      readonly slot: number;
      /** Whether its carrier holds it, rather than carrying it in another slot. */
      readonly held: boolean;
    }
  | { readonly lying: WorldEntity };

/**
 * One item somewhere in the world, as this client knows it. Whatever it does where it is, it does
 * the same held or lying: its carrier is only where it is and the way it points.
 */
export interface ItemInstance {
  readonly item: string;
  /** Where it is now: its carrier's spot, or where it lies. */
  readonly at: Point;
  /**
   * The way it points, in radians: its carrier's aim, or, lying, the way whoever laid it faced.
   */
  readonly facing: number;
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
 * A name for `instance` that holds while it stays where it is: in one slot of one carrier, or
 * lying as one entity. For what content counts of each one over time, such as a battery's drain.
 */
export const instanceKey = (instance: ItemInstance): string =>
  "carrier" in instance.place
    ? `${instance.place.carrier.id}#${String(instance.place.slot)}`
    : instance.place.lying.id;

/** `carried` in `carrier`'s `slot`, as an instance. */
const carriedInstance = (
  carrier: Player,
  carried: CarriedItem,
  slot: number,
  held: boolean,
): ItemInstance => ({
  item: carried.id,
  at: { x: carrier.x, y: carrier.y },
  facing: carrier.aim,
  left: usesLeft(carried),
  state: carried.state,
  place: { carrier, slot, held },
});

/**
 * The item `player` holds, as an instance, as `heldItemOf` reads it: the local player's as
 * predicted. Null when it holds none.
 */
export function heldInstance(
  game: Session,
  player: Player,
): ItemInstance | null {
  const held = heldItemOf(game, player);
  const slot = heldSlotOf(game, player);
  return held === null || slot === null
    ? null
    : carriedInstance(player, held, slot, true);
}

/** The item `entity` is, lying in the world, as an instance; null if it is no lying item. */
export function lyingInstance(
  game: Session,
  entity: WorldEntity,
): ItemInstance | null {
  const lying = lyingItem(game, entity);
  if (lying === null) return null;
  const definition = game.itemDefinitions.get(lying.item);
  return {
    item: lying.item,
    at: { x: entity.x, y: entity.y },
    facing: lying.facing ?? 0,
    left: lying.left ?? definition?.uses ?? null,
    state: lying.state,
    place: { lying: entity },
  };
}

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
      found.push(carriedInstance(carrier, carried, slot, held === slot));
    });
  }
  for (const entity of game.entities.values()) {
    const lying = lyingInstance(game, entity);
    if (lying === null || (item !== undefined && lying.item !== item)) continue;
    found.push(lying);
  }
  return found;
}
