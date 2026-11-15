import { z } from "zod";
import type { CarriedItem, Inventory } from "./inventory.js";
import {
  carried,
  carriedWeight,
  heldItem,
  ItemId,
  ItemState,
  UsesLeft,
  withState,
} from "./inventory.js";
import type { Player } from "./player.js";
import { playerData } from "./player-data.js";
import { handledActions } from "./prediction.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * An item in a slot as the host keeps it: its id, or its id with the uses it has left once it has
 * spent some and its own state once it keeps any.
 */
const Slot = z.union([
  ItemId,
  z.object({
    id: ItemId,
    left: UsesLeft.optional(),
    state: ItemState.optional(),
  }),
]);
type Slot = z.infer<typeof Slot>;

/** One player's items as the host keeps them: an item by slot, null for an empty slot. */
const Slots = z.array(Slot.nullable()).max(64);
type Slots = z.infer<typeof Slots>;

const idOf = (slot: Slot): string =>
  typeof slot === "string" ? slot : slot.id;
const leftIn = (slot: Slot): number | undefined =>
  typeof slot === "string" ? undefined : slot.left;
const stateIn = (slot: Slot): ItemState | undefined =>
  typeof slot === "string" ? undefined : slot.state;
const slotOf = (item: CarriedItem): Slot =>
  item.left === undefined && item.state === undefined
    ? item.id
    : {
        id: item.id,
        ...(item.left !== undefined && { left: item.left }),
        ...(item.state !== undefined && { state: item.state }),
      };

/**
 * Every player's items, by player id. The host owns them: it stocks each player it meets with
 * the room's starting items, and changes them only for the item actions it accepts. A player who
 * leaves keeps its record, and finds its items again if it comes back while the world lasts.
 */
export const inventories = worldData({
  schema: z.record(z.string(), Slots),
  initial: {},
});

/**
 * Stores of items kept by something other than a player, such as a vehicle's storage, by its id:
 * an item by slot, null for an empty slot. The host owns them, as it does players' items, and
 * every client holds them. Items in them keep their uses left and state.
 */
export const stores = worldData({
  schema: z.record(z.string(), Slots),
  initial: {},
});

/** Store `id`'s items, `size` slots of them, as the host keeps them; all empty until it has any. */
export function storeOf(game: Session, id: string, size: number): Inventory {
  const slots = stores.get(game)[id] ?? [];
  return Array.from({ length: size }, (_, slot) =>
    carriedFrom(game, slots[slot] ?? null),
  );
}

/**
 * Every store, with store `id`, `size` slots of it, holding `item` in `slot`; null empties the
 * slot. What the host sets `stores` to.
 */
export function storesWith(
  game: Session,
  id: string,
  size: number,
  slot: number,
  item: CarriedItem | null,
): Record<string, Slots> {
  const held = stores.get(game);
  const slots = Array.from(
    { length: size },
    (_, index) => held[id]?.[index] ?? null,
  );
  slots[slot] = item === null ? null : slotOf(item);
  return { ...held, [id]: slots };
}

/** What the local player's client predicted of its own items, held until the host settles it. */
export interface InventoryHold {
  /** The latest local action predicted; the host's record takes over once it has handled it. */
  readonly action: number;
  /** When, in sim seconds, the host's record takes over regardless. */
  readonly until: number;
  /** The lying items reached for under it, by entity id, which are not reached for again. */
  readonly reaching: readonly string[];
}

const slotsFor = (inventory: Inventory): Slots =>
  inventory.map((item) => (item === null ? null : slotOf(item)));

/** Player `id`'s items as the host keeps them: the room's starting items until it has a record. */
function slotsOf(game: Session, id: string): Slots {
  return inventories.get(game)[id] ?? slotsFor(game.starting);
}

function setSlots(game: Session, id: string, slots: Slots): void {
  inventories.set(game, { ...inventories.get(game), [id]: slots });
}

/** The item in `slot`, as this client knows it; null for none, or an item it does not know. */
function carriedFrom(game: Session, slot: Slot | null): CarriedItem | null {
  if (slot === null) return null;
  const definition = game.itemDefinitions.get(idOf(slot));
  return definition === undefined
    ? null
    : withState(carried(definition, leftIn(slot)), stateIn(slot));
}

/** The id of the item in `slot` of player `id`'s items as the host keeps them; null for none. */
export function itemIn(
  game: Session,
  id: string,
  slot: number | null,
): string | null {
  const held = slot === null ? null : (slotsOf(game, id)[slot] ?? null);
  return held === null ? null : idOf(held);
}

/**
 * The item in `slot` of player `id`'s items as the host keeps them, with the uses it has left;
 * null for none.
 */
export function carriedIn(
  game: Session,
  id: string,
  slot: number,
): CarriedItem | null {
  return carriedFrom(game, slotsOf(game, id)[slot] ?? null);
}

/** Player `id`'s items by slot as the host keeps them, each with its uses left and state. */
export const itemsOf = (game: Session, id: string): Inventory =>
  slotsOf(game, id).map((slot) => carriedFrom(game, slot));

/** Whether player `id` has an empty slot, as the host keeps its items. */
export const hasRoom = (game: Session, id: string): boolean =>
  slotsOf(game, id).includes(null);

/**
 * What `player` carries weighs, in pounds: the local player's items as predicted, a remote
 * player's as the host keeps them.
 */
export function weightOf(game: Session, player: Player): number {
  if (player === game.local) return carriedWeight(player.inventory);
  return carriedWeight(
    slotsOf(game, player.id).map((slot) => carriedFrom(game, slot)),
  );
}

/**
 * As the host, puts `item` in player `id`'s `slot`, or its first empty slot when left out, with
 * `left` uses left, or all its uses when left out, keeping `state` of its own, if any. Returns
 * whether it went in: false when the slot is taken or missing, or this client does not host.
 */
export function giveItem(
  game: Session,
  id: string,
  item: string,
  slot?: number,
  left?: number,
  state?: ItemState,
): boolean {
  if (!game.hosting) return false;
  const slots = [...slotsOf(game, id)];
  const index = slot ?? slots.indexOf(null);
  if (slots[index] !== null) return false;
  const definition = game.itemDefinitions.get(item);
  slots[index] =
    definition === undefined
      ? item
      : slotOf(withState(carried(definition, left), state));
  setSlots(game, id, slots);
  return true;
}

/**
 * As the host, leaves the item in player `id`'s `slot`, if it is `item`, keeping `state` of its
 * own. Returns whether it did.
 */
export const setItemState = (
  game: Session,
  id: string,
  slot: number,
  item: string,
  state: ItemState | undefined,
): boolean =>
  changeCarried(game, id, slot, item, (held) => withState(held, state));

/**
 * As the host, leaves the item in player `id`'s `slot`, if it is `item`, with `left` uses left;
 * at none it is gone. Returns whether it did.
 */
export const setUsesLeft = (
  game: Session,
  id: string,
  slot: number,
  item: string,
  left: number,
): boolean =>
  changeCarried(game, id, slot, item, (held) =>
    left <= 0 ? null : carried(held, left),
  );

/**
 * As the host, replaces the item in player `id`'s `slot`, if it is `item`, with what `change`
 * makes of it; null empties the slot. Returns whether it did.
 */
function changeCarried(
  game: Session,
  id: string,
  slot: number,
  item: string,
  change: (held: CarriedItem) => CarriedItem | null,
): boolean {
  const held = carriedIn(game, id, slot);
  if (!game.hosting || held?.id !== item) return false;
  const slots = [...slotsOf(game, id)];
  const changed = change(held);
  slots[slot] = changed === null ? null : slotOf(changed);
  setSlots(game, id, slots);
  return true;
}

/**
 * As the host, empties player `id`'s `slot` if it holds `item`. Returns whether it did: false
 * when the slot holds anything else, or this client does not host.
 */
export function takeItem(
  game: Session,
  id: string,
  slot: number,
  item: string,
): boolean {
  if (!game.hosting || itemIn(game, id, slot) !== item) return false;
  const slots = [...slotsOf(game, id)];
  slots[slot] = null;
  setSlots(game, id, slots);
  return true;
}

/** As the host, sends player `by`'s items again, as they are, with the next world state. */
export function resendItems(game: Session, by: string): void {
  if (!game.hosting) return;
  setSlots(game, by, slotsOf(game, by));
  game.worldChanged.add(inventories);
}

/**
 * Applies `change` to the local player's items at once, as the host will once it handles the
 * local action `action`, and holds them so until the host has handled it, or `net.predictionHold`
 * passes; they then take the host's record, which rolls back what the host refused.
 * `reaching` is the lying item the action picks up, if any.
 */
export function predictInventory(
  game: Session,
  action: number,
  change: (inventory: Inventory) => void,
  reaching?: string,
): void {
  change(game.local.inventory);
  game.inventoryHold = {
    action,
    until: game.time + game.config.net.predictionHold,
    reaching: [
      ...(game.inventoryHold?.reaching ?? []),
      ...(reaching === undefined ? [] : [reaching]),
    ],
  };
}

/** Whether the local player has reached for the lying item `id` and the host has yet to answer. */
export const isReaching = (game: Session, id: string): boolean =>
  game.inventoryHold?.reaching.includes(id) ?? false;

/**
 * Keeps items in step with the host each step. The host stocks each player it has no record of
 * with the starting items. The local player's items then take the host's record of them, unless
 * a prediction holds them.
 */
export function followInventories(game: Session): void {
  if (game.hosting) {
    const held = inventories.get(game);
    const missing = [...game.players.keys()].filter(
      (id) => held[id] === undefined,
    );
    const starting = slotsFor(game.starting);
    if (missing.length > 0)
      inventories.set(game, {
        ...held,
        ...Object.fromEntries(missing.map((id) => [id, starting])),
      });
  }
  const hold = game.inventoryHold;
  if (hold !== null) {
    const handled = handledActions.get(game)[game.localId] ?? 0;
    if (handled < hold.action && game.time < hold.until) return;
    game.inventoryHold = null;
  }
  const slots = inventories.get(game)[game.localId];
  if (slots === undefined) return;
  const { inventory } = game.local;
  for (const slot of inventory.keys()) {
    inventory[slot] = carriedFrom(game, slots[slot] ?? null);
  }
}

/**
 * The slot each player holds, or null for none, as the player last steered it: its simulation
 * sets it, so others hear it from the host. Any slot may be held; what is in it is the host's
 * to say.
 */
export const heldSlot = playerData({
  schema: z.number().int().min(0).max(63).nullable(),
  initial: (player: Player) => player.held,
  simulated: true,
});

/**
 * The item `player` holds; null when it holds nothing, or an item this client does not know. The
 * local player's is from its own items as predicted; a remote player's is what the host keeps in
 * the slot it holds.
 */
export function heldItemOf(game: Session, player: Player): CarriedItem | null {
  if (player === game.local) return heldItem(player.inventory, player.held);
  const slot = heldSlot.get(player);
  return slot === null ? null : carriedIn(game, player.id, slot);
}
