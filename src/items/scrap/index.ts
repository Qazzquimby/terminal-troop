import { z } from "zod";
import {
  contentEvent,
  defineItem,
  heldItemId,
  hostAccepts,
  removeItem,
  worldData,
} from "../../sim/index.js";
import type { Player, Point, Scatter, Session } from "../../sim/index.js";
import cashoutUrl from "./sfx/cashout.mp3";

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
  /** Volume of a sale's sound, 0..1. */
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

/** A sale as its seller asks for it: when it was first asked for, and where the seller stood. */
const Sell = z.object({ asked: z.number(), x: z.number(), y: z.number() });

/** The host's answer to the sale first asked for at `asked`. */
const Answer = z.object({ asked: z.number() });

/** A sale under way on this client: when it was first asked for, and last sent. */
interface Pending {
  readonly asked: number;
  readonly sent: number;
}

/**
 * Scrap: lies about the world from the start, and sells one at a time while its holder stands
 * by the cruiser.
 *
 * A sale goes:
 * 1. The seller's client, holding scrap by a cruiser with no sale under way, asks the host,
 *    naming the sale by the sim time it first asked; it keeps the scrap.
 * 2. The host checks the seller reports holding scrap, stands by a cruiser near where it was
 *    last heard, and is off its sale cooldown. It adds the credit to the world, and answers
 *    "sold"; or answers "refused". A sale it has already sold is answered "sold" again, credited
 *    once.
 * 3. On "sold" the seller's client takes one scrap out of its inventory; on either answer it may
 *    sell again after the interval. A sale with no answer is asked for again, under its first
 *    time, until one comes.
 * Every client plays the sale's sound.
 */
export const scrap = defineItem("scrap", (config: ScrapConfig) => {
  const pending = new WeakMap<Session, Pending>();
  /** On the host, when the latest sale sold to each player was first asked for. */
  const lastSold = new WeakMap<Player, number>();

  const settle = (game: Session, asked: number): boolean => {
    if (pending.get(game)?.asked !== asked) return false;
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
    receive(game, { asked }) {
      if (!settle(game, asked)) return;
      const { inventory, held } = game.local;
      const slot =
        held !== null && inventory[held]?.item.id === ITEM
          ? held
          : inventory.findIndex((stack) => stack?.item.id === ITEM);
      if (slot !== -1) removeItem(inventory, slot, 1);
    },
  });

  const refused = contentEvent({
    schema: Answer,
    to: "player",
    from: "host",
    receive(game, { asked }) {
      settle(game, asked);
    },
  });

  const sell = contentEvent({
    schema: Sell,
    to: "host",
    receive(game, { asked, x, y }, by) {
      if (!game.hosting) return;
      const player = game.players.get(by);
      if (player === undefined) return;
      if (asked <= (lastSold.get(player) ?? -Infinity)) {
        sold.send(game, by, { asked });
        return;
      }
      const at = { x, y };
      if (
        heldItemId.get(player) !== ITEM ||
        !nearCruiser(game, at, config.cashoutRadius) ||
        !hostAccepts(game, by, at, NAME, config.sellInterval)
      ) {
        refused.send(game, by, { asked });
        return;
      }
      credit.set(game, credit.get(game) + config.value);
      lastSold.set(player, asked);
      sold.send(game, by, { asked });
      cashedOut.send(game, at);
    },
  });

  return {
    name: "Scrap",
    maxStack: 1,
    emoji: "🔩",
    scatter: config.scatter,
    world: credit,
    events: { sell, sold, refused, cashedOut },
    act(game) {
      const { local } = game;
      const waiting = pending.get(game);
      if (waiting !== undefined) {
        if (game.time - waiting.sent < config.sellTimeout) return;
        pending.set(game, { asked: waiting.asked, sent: game.time });
        sell.send(game, { asked: waiting.asked, x: local.x, y: local.y });
        return;
      }
      if (game.time < (game.localReadyAt.get(NAME) ?? -Infinity)) return;
      if (heldItemId.get(local) !== ITEM) return;
      if (!nearCruiser(game, local, config.cashoutRadius)) return;
      pending.set(game, { asked: game.time, sent: game.time });
      sell.send(game, { asked: game.time, x: local.x, y: local.y });
    },
  };
});
