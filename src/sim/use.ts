import { z } from "zod";
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

/** A player's use of an item, as the host receives it: where the player stood and faced. */
export interface UseRequest {
  /** The id of the player using the item. */
  readonly by: string;
  readonly item: string;
  readonly x: number;
  readonly y: number;
  readonly aim: number;
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

/** The id of the item in `player`'s selected slot, or null for nothing. */
function selectedItemId(player: Player): string | null {
  return heldItem(player.inventory, player.held)?.item.id ?? null;
}

/**
 * The id of the item a player holds, or null for nothing: the local player's from its selected
 * slot, a remote player's as it last reported. A reported id may name an item this client does
 * not know.
 */
export const heldItemId = playerData({
  schema: z.string().min(1).max(32).nullable(),
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

/** Queues a use for the host's next step. */
export function requestUse(game: Session, request: UseRequest): void {
  game.uses.push(request);
}

/** Shows a remote player's use as this client sees it, and keeps it on the player to draw. */
export function showUse(game: Session, request: UseRequest): void {
  const behaviour = game.items.get(request.item);
  if (behaviour === undefined) return;
  const shown = behaviour.show(game, request, request.aim);
  const player = game.players.get(request.by);
  if (player !== undefined && player !== game.local)
    player.use = { item: request.item, ...shown, startedAt: game.time };
}

/**
 * Starts the local player's use of its held item, if it is usable and off cooldown, and
 * queues the request for the room to hand to the host.
 */
export function useHeldItem(game: Session): void {
  const { local } = game;
  const stack = heldItem(local.inventory, local.held);
  if (stack === null) return;
  const behaviour = game.items.get(stack.item.id);
  if (behaviour === undefined) return;
  if (
    local.use !== null &&
    game.time < local.use.startedAt + behaviour.cooldown
  )
    return;
  local.use = {
    item: stack.item.id,
    ...behaviour.show(game, local, local.aim),
    startedAt: game.time,
  };
  game.localUses.push({
    by: local.id,
    item: stack.item.id,
    x: local.x,
    y: local.y,
    aim: local.aim,
  });
}

/** Whether the host accepts `request`: near where its player was last reported, and off cooldown. */
function accepts(
  game: Session,
  request: UseRequest,
  behaviour: ItemBehaviour,
): boolean {
  const player = game.players.get(request.by);
  if (player === undefined) return false;
  const known = player === game.local ? player : { x: player.tx, y: player.ty };
  const { distance, seconds } = game.config.net.useSlack;
  if (Math.hypot(request.x - known.x, request.y - known.y) > distance)
    return false;
  const readyAt = game.readyAt.get(request.by) ?? -Infinity;
  if (game.time < readyAt - seconds) return false;
  game.readyAt.set(request.by, game.time + behaviour.cooldown);
  return true;
}

/** Applies every queued use the host accepts, then empties the queue. */
export function applyUses(game: Session): void {
  const requests = game.uses.splice(0);
  if (!game.hosting) return;
  for (const request of requests) {
    const behaviour = game.items.get(request.item);
    if (behaviour === undefined || !accepts(game, request, behaviour)) continue;
    behaviour.apply(game, request, request.aim);
  }
}
