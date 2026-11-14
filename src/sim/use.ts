import { z } from "zod";
import { defineAction, spendUses } from "./actions.js";
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

/** A use of a held item as its user sends it: the slot it holds the item in, and which way it faced. */
const ItemUseInput = z.object({
  slot: z.number().int().min(0).max(63),
  aim: z.number(),
});
type ItemUseInput = z.infer<typeof ItemUseInput>;

/** What using an item does, as its content gives it. */
export interface UseSpec {
  /** Least time between one player's uses, in sim seconds. */
  readonly cooldown: number;
  /** Uses each use spends, of an item whose uses are limited; 1 when left out. */
  readonly spends?: number;
  /**
   * Applies `use` by `user`, from where the user stands, as an action: on the user's own client
   * as it uses the item, and on the host once it accepts.
   */
  apply(game: Session, user: Player, use: ItemUseInput): void;
}

/** A control of a held item as its holder sends it: the slot it holds the item in. */
const ItemControlInput = z.object({ slot: z.number().int().min(0).max(63) });
type ItemControlInput = z.infer<typeof ItemControlInput>;

/**
 * What working a held item's control does, on the interact control when there is nothing to
 * pick up: a walkie talkie switching on or off, say.
 */
export interface ControlSpec {
  /** Least time between one player's controls of it, in sim seconds. */
  readonly cooldown: number;
  /**
   * Applies the control by `user` as an action: on the user's own client as it works it, and on
   * the host once it accepts.
   */
  apply(game: Session, user: Player, control: ItemControlInput): void;
}

/** What an item does; each item that does anything registers one under its id. */
export interface ItemBehaviour {
  /** The action of using it, sent under its content entry as `use`, if it is usable. */
  readonly use?: Action<ItemUseInput>;
  /** Draws `use` as of sim time `time`; does nothing once it has finished. */
  draw?(ctx: CanvasRenderingContext2D, use: ItemUse, time: number): void;
  /** The action of working its control, sent under its content entry as `control`, if any. */
  readonly control?: Action<ItemControlInput>;
}

/** Whether the host's record has the item `id` in `slot` of `user`'s items. */
const holds =
  (id: string) =>
  (game: Session, user: Player, { slot }: { readonly slot: number }) =>
    itemIn(game, user.id, slot) === id;

/**
 * The action of using the item `id`: the host takes it only if its record has the item in the
 * slot the use names. Each use spends the item's uses, if they are limited.
 */
export const itemUse = (id: string, spec: UseSpec): Action<ItemUseInput> =>
  defineAction<ItemUseInput>("use", {
    input: ItemUseInput,
    cooldown: spec.cooldown,
    check: holds(id),
    apply: (game, user, use) => {
      spec.apply(game, user, use);
      spendUses(game, user, use.slot, spec.spends ?? 1);
    },
  });

/**
 * The action of working the control of the item `id`: the host takes it only if its record has
 * the item in the slot the control names.
 */
export const itemControl = (
  id: string,
  spec: ControlSpec,
): Action<ItemControlInput> =>
  defineAction<ItemControlInput>("control", {
    input: ItemControlInput,
    cooldown: spec.cooldown,
    check: holds(id),
    apply: (game, user, control) => {
      spec.apply(game, user, control);
    },
  });

/** Registers `item` with `game`, and what it does, if anything. */
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

/** The local player's held item's behaviour and slot, if it holds one. */
function held(game: Session) {
  const { local } = game;
  const item = heldItem(local.inventory, local.held);
  if (item === null || local.held === null) return null;
  return { slot: local.held, behaviour: game.items.get(item.id) };
}

/** Uses the local player's held item, if it is usable, the way it faces. */
export function useHeldItem(game: Session): void {
  const holding = held(game);
  if (holding === null) return;
  holding.behaviour?.use?.perform(game, {
    slot: holding.slot,
    aim: game.local.aim,
  });
}

/** Works the local player's held item's control, if it has one. */
export function controlHeldItem(game: Session): void {
  const holding = held(game);
  if (holding === null) return;
  holding.behaviour?.control?.perform(game, { slot: holding.slot });
}
