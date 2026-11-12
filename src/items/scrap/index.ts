import { z } from "zod";
import {
  contentEvent,
  defineItem,
  heldItemId,
  hostAccepts,
  removeItem,
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
  /** How long a sale waits for the host before it asks again, in sim seconds. */
  readonly sellTimeout: number;
  /** Volume of its sounds, a sale and a drop, 0..1. */
  readonly volume: number;
  /** Where a new world lays scrap on the ground, one per spot. */
  readonly scatter: Scatter;
}

/** The content entry's name, and what sales are timed under. */
const NAME = "item/scrap";
const ITEM = "scrap";
/** The kind of entity scrap sells at. */
const CRUISER = "cruiser";

/** The team's credit: what its scrap has sold for. */
export const credit = worldData({
  schema: z.number().min(0),
  initial: 0,
});

/**
 * The latest sale the host sold each player, by player id: the number its seller gave it. Kept in
 * the world so a new host still knows which sales it has answered.
 */
const sales = worldData({
  schema: z.record(z.string(), z.number().int().min(1)),
  initial: {},
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

/** A sale's number: one past the latest of its seller's sales sold. */
const SaleNumber = z.number().int().min(1);

/** A sale as its seller asks for it: its number, and where the seller stood. */
const Sell = z.object({ sale: SaleNumber, x: z.number(), y: z.number() });

/** The host's answer to the sale numbered `sale`. */
const Answer = z.object({ sale: SaleNumber });

/** A sale under way on this client: its number, and when it was last sent. */
interface Pending {
  readonly sale: number;
  readonly sent: number;
}

/**
 * Scrap: lies about the world from the start, and sells one at a time while its holder stands
 * by the cruiser.
 *
 * A sale goes:
 * 1. The seller's client, holding scrap by a cruiser with no sale under way, asks the host,
 *    numbering the sale one past the latest of its sales sold; it keeps the scrap.
 * 2. The host checks the seller reports holding scrap, stands by a cruiser near where it was
 *    last heard, and is off its sale cooldown. It adds the credit to the world, records the sale
 *    as the seller's latest in the world, and answers "sold"; or answers "refused". A sale it, or
 *    an earlier host, has already sold is answered "sold" again, credited once.
 * 3. On "sold" the seller's client takes one scrap out of its inventory; on either answer it may
 *    sell again after the interval. A sale with no answer is asked for again, under its number,
 *    until one comes.
 * Every client plays the sale's sound.
 */
export const scrap = defineItem("scrap", (config: ScrapConfig) => {
  const pending = new WeakMap<Session, Pending>();
  /** The latest of the local player's sales its client heard sold. */
  const settled = new WeakMap<Session, number>();

  const settle = (game: Session, sale: number): boolean => {
    if (pending.get(game)?.sale !== sale) return false;
    pending.delete(game);
    game.localReadyAt.set(NAME, game.time + config.sellInterval);
    return true;
  };

  const cashedOut = contentEvent({
    schema: z.object({ x: z.number(), y: z.number() }),
    to: "all",
    from: "host",
    receive(game, at) {
      void game.sfx.play(cashoutUrl, at, game.local, {
        volume: config.volume,
      });
    },
  });

  const sold = contentEvent({
    schema: Answer,
    to: "player",
    from: "host",
    receive(game, { sale }) {
      if (!settle(game, sale)) return;
      settled.set(game, sale);
      const { inventory, held } = game.local;
      const slot =
        held !== null && inventory[held]?.id === ITEM
          ? held
          : inventory.findIndex((item) => item?.id === ITEM);
      if (slot !== -1) removeItem(inventory, slot);
    },
  });

  const refused = contentEvent({
    schema: Answer,
    to: "player",
    from: "host",
    receive(game, { sale }) {
      settle(game, sale);
    },
  });

  const sell = contentEvent({
    schema: Sell,
    to: "host",
    receive(game, { sale, x, y }, by) {
      if (!game.hosting) return;
      const player = game.players.get(by);
      if (player === undefined) return;
      const latest = sales.get(game);
      if (sale <= (latest[by] ?? 0)) {
        sold.send(game, by, { sale });
        return;
      }
      const at = { x, y };
      if (
        heldItemId.get(player) !== ITEM ||
        !nearCruiser(game, at, config.cashoutRadius) ||
        !hostAccepts(game, by, at, NAME, config.sellInterval)
      ) {
        refused.send(game, by, { sale });
        return;
      }
      credit.set(game, credit.get(game) + config.value);
      sales.set(game, { ...latest, [by]: sale });
      sold.send(game, by, { sale });
      cashedOut.send(game, at);
    },
  });

  return {
    name: "Scrap",
    emoji: "🔩",
    drop: { url: dropUrl, volume: config.volume },
    scatter: config.scatter,
    world: { credit, sales },
    events: { sell, sold, refused, cashedOut },
    act(game) {
      const { local } = game;
      const waiting = pending.get(game);
      if (waiting !== undefined) {
        if (game.time - waiting.sent < config.sellTimeout) return;
        pending.set(game, { sale: waiting.sale, sent: game.time });
        sell.send(game, { sale: waiting.sale, x: local.x, y: local.y });
        return;
      }
      if (game.time < (game.localReadyAt.get(NAME) ?? -Infinity)) return;
      if (heldItemId.get(local) !== ITEM) return;
      if (!nearCruiser(game, local, config.cashoutRadius)) return;
      const sale =
        Math.max(settled.get(game) ?? 0, sales.get(game)[game.localId] ?? 0) +
        1;
      pending.set(game, { sale, sent: game.time });
      sell.send(game, { sale, x: local.x, y: local.y });
    },
  };
});
