import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import { damaged } from "./entities.js";
import { movement } from "./movement.js";
import { noiseMade } from "./noise.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import type { Session } from "./session.js";
import { heldItemId, itemUsed } from "./use.js";
import { granted, pickedUp, returned } from "./world-items.js";

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
  /** How each player moves, which its footsteps follow. */
  "core/movement": { player: movement },
  /** Each noise the host makes, made again on every client. */
  "core/noise": { events: { made: noiseMade } },
  /** The damage the host deals each player, sent to that player's own client. */
  "core/health": { events: { damage: damaged } },
  /** Items lying in the world: each pickup the host checks, and the item it grants. */
  "core/world-items": { events: { pickedUp, granted, returned } },
};

/** Registers the engine's own player state and events with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, { player, events }] of Object.entries(BUILT_INS)) {
    if (player !== undefined) registerPlayerData(game, name, player);
    if (events !== undefined) registerEvents(game, name, events);
  }
}
