import { z } from "zod";
import { contentEvent } from "./content-event.js";
import { itemIn } from "./inventories.js";
import { heldItem, ItemId } from "./inventory.js";
import type { ItemDefinition } from "./inventory.js";
import type { Point } from "./map.js";
import { confirmAction, nextAction } from "./prediction.js";
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
  /** Applies a use by player `by` standing at `at`, facing `aim`. Runs only on the host. */
  apply(game: Session, at: Point, aim: number, by: string): void;
  /**
   * Predicts what the local player's use at `at`, facing `aim`, does to world entities, until
   * the host confirms the local action `action`. Runs on the user's own client, after `show`.
   * Without it, the use's effects wait for the host.
   */
  predict?(game: Session, at: Point, aim: number, action: number): void;
  /**
   * Starts a use by player `by` standing at `at`, facing `aim`, as this client sees it: plays
   * its sound for this client's listener, and returns where it lands and whether it hits.
   */
  show(
    game: Session,
    at: Point,
    aim: number,
    by: string,
  ): Pick<ItemUse, "center" | "hit">;
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

/** Registers `item` with `game`, and what using it does, if it is usable. */
export function registerItem(
  game: Session,
  item: ItemDefinition,
  behaviour?: ItemBehaviour,
): void {
  if (game.itemDefinitions.has(item.id))
    throw new Error(`Item already registered: ${item.id}`);
  game.itemDefinitions.set(item.id, item);
  if (behaviour !== undefined) game.items.set(item.id, behaviour);
}

/**
 * A player's use of an item: which item, the slot it holds it in, where the player stood and
 * faced, and its action number.
 */
const ItemUsed = z.object({
  item: ItemId,
  slot: z.number().int().min(0),
  x: z.number(),
  y: z.number(),
  aim: z.number(),
  action: z.number().int().positive(),
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
  const { distance } = game.config.net.useSlack;
  if (Math.hypot(at.x - known.x, at.y - known.y) > distance) return false;
  return hostReady(game, by, key, cooldown);
}

/**
 * Whether the host takes an action by player `by`, timed under `key`, as off cooldown. A taken
 * action starts `cooldown` seconds of it.
 */
export function hostReady(
  game: Session,
  by: string,
  key: string,
  cooldown: number,
): boolean {
  const { seconds } = game.config.net.useSlack;
  const timers = game.readyAt.get(key) ?? new Map<string, number>();
  const readyAt = timers.get(by) ?? -Infinity;
  if (game.time < readyAt - seconds) return false;
  timers.set(by, game.time + cooldown);
  game.readyAt.set(key, timers);
  return true;
}

/**
 * A player's item use, sent to everyone: each other client shows it on the player, and the host
 * confirms it handled the use, and applies it if it accepts it. The host refuses outright a use
 * of an item its record does not have in the slot the use names.
 */
export const itemUsed = contentEvent({
  schema: ItemUsed,
  to: "all",
  receive(game, use, by) {
    const behaviour = game.items.get(use.item);
    if (behaviour === undefined) return;
    const player = game.players.get(by);
    if (player === undefined) return;
    if (game.hosting) {
      confirmAction(game, by, use.action);
      if (itemIn(game, by, use.slot) !== use.item) return;
    }
    if (player !== game.local)
      player.use = {
        item: use.item,
        ...behaviour.show(game, use, use.aim, by),
        startedAt: game.time,
      };
    if (
      game.hosting &&
      hostAccepts(game, by, use, ITEM_COOLDOWN, behaviour.cooldown)
    )
      behaviour.apply(game, use, use.aim, by);
  },
});

/**
 * Starts the local player's use of its held item, if it is usable and off cooldown, predicts
 * what it does, and sends it to everyone.
 */
export function useHeldItem(game: Session): void {
  const { local } = game;
  const item = heldItem(local.inventory, local.held);
  if (item === null || local.held === null) return;
  const behaviour = game.items.get(item.id);
  if (behaviour === undefined) return;
  if (
    local.use !== null &&
    game.time < local.use.startedAt + behaviour.cooldown
  )
    return;
  local.use = {
    item: item.id,
    ...behaviour.show(game, local, local.aim, local.id),
    startedAt: game.time,
  };
  const action = nextAction(game);
  behaviour.predict?.(game, local, local.aim, action);
  itemUsed.send(game, {
    item: item.id,
    slot: local.held,
    x: local.x,
    y: local.y,
    aim: local.aim,
    action,
  });
}
