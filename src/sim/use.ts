import { z } from "zod";
import { defineAction } from "./actions.js";
import type { Action } from "./actions.js";
import { itemIn } from "./inventories.js";
import { heldItem } from "./inventory.js";
import type { ItemDefinition } from "./inventory.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/** A player's item use, as plain data: what this client sees of it. */
export interface ItemUse {
  readonly item: string;
  /** Where the use landed. */
  readonly center: Point;
  /** Whether it connected with anything. */
  readonly hit: boolean;
  /** When it started, in sim seconds. */
  readonly startedAt: number;
}

/** A use of a held item as its user sends it: the slot it holds the item in, where it stood and which way it faced. */
const ItemUseInput = z.object({
  slot: z.number().int().min(0).max(63),
  x: z.number(),
  y: z.number(),
  aim: z.number(),
});
type ItemUseInput = z.infer<typeof ItemUseInput>;

/** What using an item does, as its content gives it. */
export interface UseSpec {
  /** Least time between one player's uses, in sim seconds. */
  readonly cooldown: number;
  /**
   * Applies `use` by `user`, as an action: on the user's own client as it uses the item, and on
   * the host once it accepts.
   */
  apply(game: Session, user: Player, use: ItemUseInput): void;
}

/** What a usable item does; each usable item registers one under its id. */
export interface ItemBehaviour {
  /** The action of using it, sent under its content entry as `use`. */
  readonly use: Action<ItemUseInput>;
  /** Draws `use` as of sim time `time`; does nothing once it has finished. */
  draw(ctx: CanvasRenderingContext2D, use: ItemUse, time: number): void;
}

/** How far the host trusts when a player's action arrives. */
export interface UseSlack {
  /** How much sooner than its cooldown allows an action may arrive, in seconds. */
  readonly seconds: number;
}

/**
 * The action of using the item `id`: the host takes it from where the user says it stood, as it
 * would take a move there, and only if its record has the item in the slot the use names.
 */
export const itemUse = (id: string, spec: UseSpec): Action<ItemUseInput> =>
  defineAction("use", {
    input: ItemUseInput,
    cooldown: spec.cooldown,
    stood: (_user, { x, y }) => ({ at: { x, y } }),
    check: (game, user, { slot }) => itemIn(game, user.id, slot) === id,
    apply: (game, user, use) => {
      spec.apply(game, user, use);
    },
  });

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

/** Uses the local player's held item, if it is usable: from where it stands, the way it faces. */
export function useHeldItem(game: Session): void {
  const { local } = game;
  const item = heldItem(local.inventory, local.held);
  if (item === null || local.held === null) return;
  game.items.get(item.id)?.use.perform(game, {
    slot: local.held,
    x: local.x,
    y: local.y,
    aim: local.aim,
  });
}
