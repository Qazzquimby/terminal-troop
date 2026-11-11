import { z } from "zod";
import { contentEvent } from "./content-event.js";
import { heldItem } from "./inventory.js";
import type { ItemDefinition } from "./inventory.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import { playerData } from "./player-data.js";
import type { Session } from "./session.js";

/** A player's item use, as plain data: what this client sees of it. */
export interface ItemUse {
  readonly item: string;
  /** Where the use landed. */
  readonly center: Point;
  /** Whether it connected with anything, as this client saw it. */
  readonly hit: boolean;
  /** When it started, in sim seconds. */
  readonly startedAt: number;
}

/** What a usable item does; each usable item registers one under its id. */
export interface ItemBehaviour {
  /** Minimum time between uses, in sim seconds. */
  readonly cooldown: number;
  /** Applies a use by a player standing at `at`, facing `aim`. Runs only on the host. */
  apply(game: Session, at: Point, aim: number): void;
  /**
   * Starts a use by a player standing at `at`, facing `aim`, as this client sees it: plays its
   * sound for this client's listener, and returns where it lands and whether it hits.
   */
  show(game: Session, at: Point, aim: number): Pick<ItemUse, "center" | "hit">;
  /** Draws `use` as of sim time `time`; does nothing once it has finished. */
  draw(ctx: CanvasRenderingContext2D, use: ItemUse, time: number): void;
}

/** How far the host trusts a use's report of where and when it happened. */
export interface UseSlack {
  /** Furthest, in pixels, a use may be from where its player was last reported. */
  readonly distance: number;
  /** How much sooner than its cooldown allows a use may arrive, in seconds. */
  readonly seconds: number;
}

/** Registers `item` with `game`, and what using it does. */
export function registerItem(
  game: Session,
  item: ItemDefinition,
  behaviour: ItemBehaviour,
): void {
  if (game.items.has(item.id))
    throw new Error(`Item already registered: ${item.id}`);
  game.itemDefinitions.set(item.id, item);
  game.items.set(item.id, behaviour);
}

/** An item's id, as a player reports it. */
const ItemId = z.string().min(1).max(32);

/** The id of the item in `player`'s selected slot, or null for nothing. */
function selectedItemId(player: Player): string | null {
  return heldItem(player.inventory, player.held)?.id ?? null;
}

/**
 * The id of the item a player holds, or null for nothing: the local player's from its selected
 * slot, a remote player's as it last reported. A reported id may name an item this client does
 * not know.
 */
export const heldItemId = playerData({
  schema: ItemId.nullable(),
  initial: selectedItemId,
});

/** Keeps the local player's held item id in step with its selected slot. */
export function reportHeld(local: Player): void {
  heldItemId.set(local, selectedItemId(local));
}

/** The item `player` holds; null when it holds nothing, or an item this client does not know. */
export function heldItemOf(
  game: Session,
  player: Player,
): ItemDefinition | null {
  const id = heldItemId.get(player);
  return id === null ? null : (game.itemDefinitions.get(id) ?? null);
}

/** A player's use of an item: which item, and where the player stood and faced. */
const ItemUsed = z.object({
  item: ItemId,
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});

/** What an item use is timed under: every item shares one cooldown per player. */
const ITEM_COOLDOWN = "item";

/**
 * Whether the host accepts an action by player `by`, timed under `key`, that it reports doing at
 * `at`: near where its player was last reported, and off cooldown. An accepted action starts
 * `cooldown` seconds of it.
 */
export function hostAccepts(
  game: Session,
  by: string,
  at: Point,
  key: string,
  cooldown: number,
): boolean {
  const player = game.players.get(by);
  if (player === undefined) return false;
  const known = player === game.local ? player : { x: player.tx, y: player.ty };
  const { distance, seconds } = game.config.net.useSlack;
  if (Math.hypot(at.x - known.x, at.y - known.y) > distance) return false;
  const timers = game.readyAt.get(key) ?? new Map<string, number>();
  const readyAt = timers.get(by) ?? -Infinity;
  if (game.time < readyAt - seconds) return false;
  timers.set(by, game.time + cooldown);
  game.readyAt.set(key, timers);
  return true;
}

/**
 * A player's item use, sent to everyone: each other client shows it on the player, and the host
 * applies it if it accepts it.
 */
export const itemUsed = contentEvent({
  schema: ItemUsed,
  to: "all",
  receive(game, use, by) {
    const behaviour = game.items.get(use.item);
    if (behaviour === undefined) return;
    const player = game.players.get(by);
    if (player !== undefined && player !== game.local)
      player.use = {
        item: use.item,
        ...behaviour.show(game, use, use.aim),
        startedAt: game.time,
      };
    if (
      game.hosting &&
      hostAccepts(game, by, use, ITEM_COOLDOWN, behaviour.cooldown)
    )
      behaviour.apply(game, use, use.aim);
  },
});

/**
 * Starts the local player's use of its held item, if it is usable and off cooldown, and sends
 * it to everyone.
 */
export function useHeldItem(game: Session): void {
  const { local } = game;
  const item = heldItem(local.inventory, local.held);
  if (item === null) return;
  const behaviour = game.items.get(item.id);
  if (behaviour === undefined) return;
  if (
    local.use !== null &&
    game.time < local.use.startedAt + behaviour.cooldown
  )
    return;
  local.use = {
    item: item.id,
    ...behaviour.show(game, local, local.aim),
    startedAt: game.time,
  };
  itemUsed.send(game, {
    item: item.id,
    x: local.x,
    y: local.y,
    aim: local.aim,
  });
}
