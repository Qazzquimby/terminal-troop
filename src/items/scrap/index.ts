import { z } from "zod";
import {
  changeWorld,
  defineItem,
  effect,
  heldSlot,
  itemIn,
  itemsOf,
  sound,
  take,
  worldData,
} from "../../sim/index.js";
import type {
  ItemTraits,
  Player,
  Point,
  Scatter,
  Session,
} from "../../sim/index.js";
import cashoutUrl from "./sfx/cashout.mp3";
import dropUrl from "./sfx/drop.mp3";

/** Scrap: picked up off the ground and sold at the cruiser for the team's credit. */
export interface ScrapConfig extends ItemTraits {
  /** Credit one scrap sells for. */
  readonly value: number;
  /** How near the cruiser's body a player stands to sell, in pixels. */
  readonly cashoutRadius: number;
  /** Least time between one player's sales, in sim seconds. */
  readonly sellInterval: number;
  /** Volume of its sounds, a sale and a drop, 0..1. */
  readonly volume: number;
  /**
   * How far, in pixels, its clatter carries as it is dropped, by anything that drops it: heard by
   * players, and as a noise by whatever listens.
   */
  readonly dropNoiseRadius: number;
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

/**
 * The slot of `seller`'s scrap to sell next: the one it holds, if scrap, else its first scrap in
 * any slot; null for none.
 */
function scrapSlot(game: Session, seller: Player): number | null {
  const held = heldSlot.get(seller);
  if (held !== null && itemIn(game, seller.id, held) === ITEM) return held;
  const slot = itemsOf(game, seller.id).findIndex((item) => item?.id === ITEM);
  return slot === -1 ? null : slot;
}

/**
 * Scrap: lies about the world from the start, and sells while its carrier stands by the cruiser:
 * every scrap it carries, in any slot, one each sell interval, the held one first. Dropped, by a
 * player or anything else that lays it down, it clatters loud enough for monsters to hear.
 *
 * Selling is the host's rule: each step it sells for every player that carries scrap by a
 * cruiser, as the host runs the player, and whose interval has run. It takes the scrap out of the
 * player's items and adds the credit to the world, which reach every client with the world state,
 * and every client plays the sale's sound.
 */
export const scrap = defineItem("scrap", (config: ScrapConfig) => {
  const cashout = sound({ url: cashoutUrl, volume: config.volume });
  /** When, on the host's clock, each player may next sell, by player id, per session. */
  const nextSale = new WeakMap<Session, Map<string, number>>();

  return {
    name: "Scrap",
    emoji: "🔩",
    drop: sound({
      url: dropUrl,
      volume: config.volume,
      range: config.dropNoiseRadius,
    }),
    traits: config,
    scatter: config.scatter,
    world: { credit },
    step(game) {
      const due = nextSale.get(game) ?? new Map<string, number>();
      nextSale.set(game, due);
      for (const seller of game.players.values()) {
        const slot = scrapSlot(game, seller);
        if (slot === null) continue;
        if (game.time < (due.get(seller.id) ?? -Infinity)) continue;
        if (!nearCruiser(game, seller, config.cashoutRadius)) continue;
        if (take(game, seller, slot, ITEM) === null) continue;
        due.set(seller.id, game.time + config.sellInterval);
        changeWorld(game, credit, (value) => value + config.value);
        effect(
          game,
          { at: { x: seller.x, y: seller.y }, sound: cashout },
          seller,
        );
      }
    },
  };
});
