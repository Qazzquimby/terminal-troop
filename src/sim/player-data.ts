import type { z } from "zod";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/** State a content entry keeps on every player: each player owns its own, and reports it in its STATE. */
export interface PlayerDataSpec<S> {
  /**
   * Checks a value, encodes it for the wire and decodes it back. A codec carries what JSON
   * cannot, such as Infinity.
   */
  readonly schema: z.ZodType<S>;
  /** A player's value until it is set or heard. */
  readonly initial: (player: Player) => S;
}

/** Reads and writes a content entry's state on any player, typed by its schema. */
export interface PlayerData<S> extends PlayerDataSpec<S> {
  get(player: Player): S;
  /** Throws when `value` does not encode. */
  set(player: Player, value: S): void;
}

/** A content entry's per-player state, read and written through the returned accessor. */
export function playerData<S>(spec: PlayerDataSpec<S>): PlayerData<S> {
  const { schema, initial } = spec;
  const data: PlayerData<S> = {
    schema,
    initial,
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

/** The local player's state of every content entry, each encoded by its own schema, by name. */
export function contentState(game: Session): Record<string, unknown> {
  return Object.fromEntries(
    [...game.playerData].map(([name, data]) => [
      name,
      data.schema.encode(data.get(game.local)),
    ]),
  );
}

/**
 * Applies a remote player's reported content state: each value decoded by its own entry's
 * schema. A value of an unregistered entry, or one its schema rejects, is dropped; an entry
 * missing from `content` keeps its value.
 */
export function applyContentState(
  game: Session,
  player: Player,
  content: Readonly<Record<string, unknown>>,
): void {
  for (const [name, wire] of Object.entries(content)) {
    const data = game.playerData.get(name);
    if (data === undefined) continue;
    const parsed = data.schema.safeParse(wire);
    if (parsed.success) data.set(player, parsed.data);
  }
}
