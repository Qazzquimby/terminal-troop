import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import type { Session } from "./session.js";
import { heldItemId, itemUsed } from "./use.js";

/** State the engine itself keeps on every player, and events it sends, under one name. */
interface BuiltIn {
  readonly player?: PlayerData<unknown>;
  readonly events?: ContentEvents;
}

/**
 * The engine's own player state and events, by the name each travels under. Every session has
 * them, and content may not use these names.
 */
const BUILT_INS: Readonly<Record<string, BuiltIn>> = {
  /** The id of the item each player holds, and each use of it. */
  held: { player: heldItemId, events: { use: itemUsed } },
};

export const RESERVED_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BUILT_INS),
);

/** Registers the engine's own player state and events with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, { player, events }] of Object.entries(BUILT_INS)) {
    if (player !== undefined) registerPlayerData(game, name, player);
    if (events !== undefined) registerEvents(game, name, events);
  }
}
