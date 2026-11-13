import { z } from "zod";
import {
  changeWorld,
  defineAction,
  defineItem,
  effect,
  heldItemOf,
  itemIn,
  sound,
  take,
  worldData,
} from "../../sim/index.js";
import type { Point, Scatter, Session } from "../../sim/index.js";
import cashoutUrl from "./sfx/cashout.mp3";
import dropUrl from "./sfx/drop.mp3";

/** Scrap: picked up off the ground and sold at the cruiser for the team's credit. */
export interface ScrapConfig {
  /** Credit one scrap sells for. */
  readonly value: number;
  /** How near the cruiser's body a player stands to sell, in pixels. */
  readonly cashoutRadius: number;
  /** Least time between one player's sales, in sim seconds. */
  readonly sellInterval: number;
  /** Volume of its sounds, a sale and a drop, 0..1. */
  readonly volume: number;
  /** Where a new world lays scrap on the ground, one per spot. */
  readonly scatter: Scatter;
}

const ITEM = "scrap";
/** The kind of entity scrap sells at. */
const CRUISER = "cruiser";

/** The team's credit: what its scrap has sold for. */
export const credit = worldData({
  schema: z.number().min(0),
  initial: 0,
});

/** Whether `at` is near enough a cruiser to sell at it. */
function nearCruiser(game: Session, at: Point, radius: number): boolean {
  const kind = game.kindIds.get(CRUISER);
  for (const entity of game.entities.values()) {
    if (entity.kind !== kind) continue;
    if (Math.hypot(entity.x - at.x, entity.y - at.y) <= radius + entity.radius)
      return true;
  }
  return false;
}

/** A sale as its seller sends it: the slot its scrap is in, and where the seller stood. */
const Sale = z.object({
  slot: z.number().int().min(0).max(63),
  x: z.number(),
  y: z.number(),
});

/**
 * Scrap: lies about the world from the start, and sells one at a time while its holder stands
 * by the cruiser, at most once each sell interval.
 *
 * A sale is an action. The seller's client shows the scrap gone at once. The host takes it if its
 * record has scrap in the slot the sale names, and the seller stood by a cruiser where it says,
 * as the host would take a move there: it takes the scrap out of the seller's slot and adds the
 * credit to the world. Either way the seller's items then follow the host's record, which brings
 * back scrap a refused sale showed gone, and scrap still held by the cruiser is sold again. Every
 * client plays the sale's sound.
 */
export const scrap = defineItem("scrap", (config: ScrapConfig) => {
  const cashout = sound({ url: cashoutUrl, volume: config.volume });

  const sell = defineAction("sell", {
    input: Sale,
    cooldown: config.sellInterval,
    stood: (_seller, { x, y }) => ({ at: { x, y } }),
    check: (game, seller, { slot, x, y }) =>
      itemIn(game, seller.id, slot) === ITEM &&
      nearCruiser(game, { x, y }, config.cashoutRadius),
    apply(game, seller, { slot, x, y }) {
      if (take(game, seller, slot, ITEM) === null) return;
      changeWorld(game, credit, (value) => value + config.value);
      effect(game, { at: { x, y }, sound: cashout });
    },
  });

  return {
    name: "Scrap",
    emoji: "🔩",
    drop: sound({ url: dropUrl, volume: config.volume }),
    scatter: config.scatter,
    world: { credit },
    actions: [sell],
    act(game) {
      const { local } = game;
      if (local.held === null || heldItemOf(game, local)?.id !== ITEM) return;
      if (!nearCruiser(game, local, config.cashoutRadius)) return;
      sell.perform(game, { slot: local.held, x: local.x, y: local.y });
    },
  };
});
