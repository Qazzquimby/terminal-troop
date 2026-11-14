import type { z } from "zod";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/**
 * State a content entry keeps on every player. By default each player owns its own and reports
 * it; state the player's simulation sets is the host's, and travels with the player's state.
 */
export interface PlayerDataSpec<S> {
  /**
   * Checks a value, encodes it for the wire and decodes it back. A codec carries what JSON
   * cannot, such as Infinity.
   */
  readonly schema: z.ZodType<S>;
  /** A player's value until it is set or heard. */
  readonly initial: (player: Player) => S;
  /**
   * Whether the player's simulation sets it, wherever that runs: the host's, sent with the
   * player's state, rather than reported by the player. False when left out.
   */
  readonly simulated?: boolean;
}

/** Reads and writes a content entry's state on any player, typed by its schema. */
export interface PlayerData<S> extends PlayerDataSpec<S> {
  get(player: Player): S;
  /** Throws when `value` does not encode. */
  set(player: Player, value: S): void;
}

/** A content entry's per-player state, read and written through the returned accessor. */
export function playerData<S>(spec: PlayerDataSpec<S>): PlayerData<S> {
  const { schema, initial, simulated = false } = spec;
  const data: PlayerData<S> = {
    schema,
    initial,
    simulated,
    get(player) {
      if (!player.content.has(data)) return initial(player);
      return schema.parse(player.content.get(data));
    },
    set(player, value) {
      player.content.set(data, schema.encode(value));
    },
  };
  return data;
}

/** Registers `data` under the content entry `name`, the key the entry's state travels under. */
export function registerPlayerData(
  game: Session,
  name: string,
  data: PlayerData<unknown>,
): void {
  if (game.playerData.has(name))
    throw new Error(`Player data already registered: ${name}`);
  game.playerData.set(name, data);
}

/**
 * `player`'s state of every content entry, each encoded by its own schema, by name: what the
 * player reports of itself, or with `simulated`, what its simulation sets.
 */
export function contentState(
  game: Session,
  player: Player,
  simulated: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    [...game.playerData]
      .filter(([, data]) => (data.simulated ?? false) === simulated)
      .map(([name, data]) => [name, data.schema.encode(data.get(player))]),
  );
}

/**
 * Applies a player's content state as heard: what it reports of itself, or with `simulated`,
 * what its simulation set on the host. Each value is decoded by its own entry's schema. A value
 * of an unregistered entry, of the other kind, or one its schema rejects, is dropped; an entry
 * missing from `content` keeps its value.
 */
export function applyContentState(
  game: Session,
  player: Player,
  content: Readonly<Record<string, unknown>>,
  simulated: boolean,
): void {
  for (const [name, wire] of Object.entries(content)) {
    const data = game.playerData.get(name);
    if (data === undefined || (data.simulated ?? false) !== simulated) continue;
    const parsed = data.schema.safeParse(wire);
    if (parsed.success) data.set(player, parsed.data);
  }
}
