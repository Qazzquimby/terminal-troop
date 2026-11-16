import {
  changeWorld,
  credit,
  defineItem,
  effect,
  footprintOf,
  gapTo,
  heldSlot,
  itemIn,
  itemsOf,
  sound,
  take,
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
  /** Least time between one player's sales, of any kind of scrap, in sim seconds. */
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

/** How a kind of scrap looks and sounds. */
interface ScrapLook {
  readonly name: string;
  readonly emoji: string;
  /** The colour it glows and glints in, if any. */
  readonly glint?: string;
  /** Its sale's sound file. */
  readonly cashoutUrl: string;
  /** Its clatter's sound file. */
  readonly dropUrl: string;
}

/** The kind of entity scrap sells at. */
const CRUISER = "cruiser";

/** Every kind of scrap defined, by item id: each sells at the cruiser. */
const KINDS = new Set<string>();

/**
 * When, on the host's clock, each player may next sell, by player id, per session; shared by every
 * kind of scrap, so a player sells one piece each interval, whatever kinds it carries.
 */
const nextSale = new WeakMap<Session, Map<string, number>>();

export { credit };

/** Whether `at` is near enough a cruiser to sell at it. */
function nearCruiser(game: Session, at: Point, radius: number): boolean {
  const kind = game.kindIds.get(CRUISER);
  for (const entity of game.entities.values()) {
    if (entity.kind !== kind) continue;
    if (gapTo(footprintOf(game, entity), at) <= radius) return true;
  }
  return false;
}

/**
 * The slot of `seller`'s `item` to sell next: the one it holds, if that is `item`, else its first
 * `item` in any slot; null for none, or while it holds another kind of scrap, which sells first.
 */
function saleSlot(game: Session, seller: Player, item: string): number | null {
  const held = heldSlot.get(seller);
  const holding = held === null ? null : itemIn(game, seller.id, held);
  if (holding === item) return held;
  if (holding !== null && KINDS.has(holding)) return null;
  const slot = itemsOf(game, seller.id).findIndex((each) => each?.id === item);
  return slot === -1 ? null : slot;
}

/**
 * A kind of scrap, as the item `id`: lies about the world from the start, and sells while its
 * carrier stands by the cruiser for its value: every scrap it carries, of any kind and in any
 * slot, one each sell interval, the held one first. Dropped, by a player or anything else that
 * lays it down, it clatters loud enough for monsters to hear.
 *
 * Selling is the host's rule: each step it sells for every player that carries scrap by a
 * cruiser, as the host runs the player, and whose interval has run. It takes the scrap out of the
 * player's items and adds the credit to the world, which reach every client with the world state,
 * and every client plays the sale's sound.
 */
export function defineScrap<N extends string>(id: N, look: ScrapLook) {
  KINDS.add(id);
  return defineItem(id, (config: ScrapConfig) => {
    const cashout = sound({ url: look.cashoutUrl, volume: config.volume });
    return {
      name: look.name,
      emoji: look.emoji,
      ...(look.glint !== undefined && { glint: look.glint }),
      drop: sound({
        url: look.dropUrl,
        volume: config.volume,
        range: config.dropNoiseRadius,
      }),
      traits: config,
      scatter: config.scatter,
      step(game) {
        const due = nextSale.get(game) ?? new Map<string, number>();
        nextSale.set(game, due);
        for (const seller of game.players.values()) {
          if (game.time < (due.get(seller.id) ?? -Infinity)) continue;
          const slot = saleSlot(game, seller, id);
          if (slot === null) continue;
          if (!nearCruiser(game, seller, config.cashoutRadius)) continue;
          if (take(game, seller, slot, id) === null) continue;
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
}

/** Plain scrap, worth the least. */
export const scrap = defineScrap("scrap", {
  name: "Scrap",
  emoji: "🔩",
  cashoutUrl,
  dropUrl,
});
