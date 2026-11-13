import { z } from "zod";
import type { Inventory, ItemDefinition } from "./inventory.js";
import { heldItem, ItemId } from "./inventory.js";
import type { Player } from "./player.js";
import { playerData } from "./player-data.js";
import { handledActions } from "./prediction.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/** One player's items as the host keeps them: an item id by slot, null for an empty slot. */
const Slots = z.array(ItemId.nullable()).max(64);
type Slots = z.infer<typeof Slots>;

/**
 * Every player's items, by player id. The host owns them: it stocks each player it meets with
 * the room's starting items, and changes them only for the item actions it accepts. A player who
 * leaves keeps its record, and finds its items again if it comes back while the world lasts.
 */
export const inventories = worldData({
  schema: z.record(z.string(), Slots),
  initial: {},
});

/** What the local player's client predicted of its own items, held until the host settles it. */
export interface InventoryHold {
  /** The latest local action predicted; the host's record takes over once it has handled it. */
  readonly action: number;
  /** When, in sim seconds, the host's record takes over regardless. */
  readonly until: number;
  /** The lying items reached for under it, by entity id, which are not reached for again. */
  readonly reaching: readonly string[];
}

const idsOf = (inventory: Inventory): Slots =>
  inventory.map((item) => item?.id ?? null);

/** Player `id`'s items as the host keeps them: the room's starting items until it has a record. */
function slotsOf(game: Session, id: string): Slots {
  return inventories.get(game)[id] ?? idsOf(game.starting);
}

function setSlots(game: Session, id: string, slots: Slots): void {
  inventories.set(game, { ...inventories.get(game), [id]: slots });
}

/** The id of the item in `slot` of player `id`'s items as the host keeps them; null for none. */
export function itemIn(
  game: Session,
  id: string,
  slot: number | null,
): string | null {
  return slot === null ? null : (slotsOf(game, id)[slot] ?? null);
}

/** Whether player `id` has an empty slot, as the host keeps its items. */
export const hasRoom = (game: Session, id: string): boolean =>
  slotsOf(game, id).includes(null);

/**
 * As the host, puts `item` in player `id`'s `slot`, or its first empty slot when left out.
 * Returns whether it went in: false when the slot is taken or missing, or this client does not host.
 */
export function giveItem(
  game: Session,
  id: string,
  item: string,
  slot?: number,
): boolean {
  if (!game.hosting) return false;
  const slots = [...slotsOf(game, id)];
  const index = slot ?? slots.indexOf(null);
  if (slots[index] !== null) return false;
  slots[index] = item;
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
    const starting = idsOf(game.starting);
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
    const id = slots[slot] ?? null;
    inventory[slot] =
      id === null ? null : (game.itemDefinitions.get(id) ?? null);
  }
}

/**
 * The slot each player holds, or null for none: the local player's as selected, a remote
 * player's as it last reported. Any slot may be held; what is in it is the host's to say.
 */
export const heldSlot = playerData({
  schema: z.number().int().min(0).max(63).nullable(),
  initial: (player: Player) => player.held,
});

/**
 * Keeps the local player's reported slot in step with its selection. A change goes out at once,
 * so others see the newly held item without waiting.
 */
export function reportHeld(game: Session): void {
  const { local } = game;
  if (local.content.has(heldSlot) && heldSlot.get(local) === local.held) return;
  heldSlot.set(local, local.held);
  game.reportNow = true;
}

/**
 * The item `player` holds; null when it holds nothing, or an item this client does not know. The
 * local player's is from its own items as predicted; a remote player's is what the host keeps in
 * the slot it reports holding.
 */
export function heldItemOf(
  game: Session,
  player: Player,
): ItemDefinition | null {
  if (player === game.local) return heldItem(player.inventory, player.held);
  const id = itemIn(game, player.id, heldSlot.get(player));
  return id === null ? null : (game.itemDefinitions.get(id) ?? null);
}
