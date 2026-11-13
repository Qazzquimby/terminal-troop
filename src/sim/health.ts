import { z } from "zod";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * Health: any number from 0 up, Infinity included. JSON has no Infinity, so it travels as the
 * string "Infinity". z.number() rejects NaN and ±Infinity.
 */
export const Health = z.codec(
  z.union([z.number().min(0), z.literal("Infinity")]),
  z.union([z.number().min(0), z.literal(Infinity)]),
  {
    decode: (wire) => (wire === "Infinity" ? Infinity : wire),
    encode: (health) => (health === Infinity ? "Infinity" : health),
  },
);

/**
 * Each player's health as the host keeps it, by player id; a player with no entry is at full.
 * It travels with the world state, so every client, a late joiner and the next host included,
 * holds it.
 */
export const playerHealth = worldData({
  schema: z.record(z.string(), Health),
  initial: {},
});

/** `player`'s health on the host's record, at most its full. */
function recordedHealth(game: Session, player: Player): number {
  return Math.min(
    playerHealth.get(game)[player.id] ?? player.maxHealth,
    player.maxHealth,
  );
}

/** Shows every player's health as the host's record has it, whatever this client set it to. */
export function followHealth(game: Session): void {
  for (const player of game.players.values())
    player.health = recordedHealth(game, player);
}

/**
 * Deals `amount` damage to `player`, as the host: the damage comes off the host's record of the
 * player's health, which every client shows. Returns the health the player has left on the
 * record; the host alone declares a player down, once that reaches 0. On a client not hosting,
 * or for a player not in the session, does nothing and returns the health this client shows.
 */
export function hurtPlayer(
  game: Session,
  player: Player,
  amount: number,
): number {
  if (!game.hosting || game.players.get(player.id) !== player)
    return player.health;
  if (amount > 0) {
    const left = Math.max(0, recordedHealth(game, player) - amount);
    playerHealth.set(game, { ...playerHealth.get(game), [player.id]: left });
    player.health = left;
  }
  return player.health;
}
