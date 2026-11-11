import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import { damaged } from "./entities.js";
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
 * them, under `core/`, a namespace content names cannot take.
 */
const BUILT_INS: Readonly<Record<`core/${string}`, BuiltIn>> = {
  /** The id of the item each player holds, and each use of it. */
  "core/items": { player: heldItemId, events: { use: itemUsed } },
  /** The damage the host deals each player, sent to that player's own client. */
  "core/health": { events: { damage: damaged } },
};

/** Registers the engine's own player state and events with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, { player, events }] of Object.entries(BUILT_INS)) {
    if (player !== undefined) registerPlayerData(game, name, player);
    if (events !== undefined) registerEvents(game, name, events);
  }
}
