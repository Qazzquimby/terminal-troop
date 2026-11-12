import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import { corrected } from "./correction.js";
import { damaged } from "./health.js";
import { movement } from "./movement.js";
import { noiseMade } from "./noise.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import { handledActions } from "./prediction.js";
import type { Session } from "./session.js";
import { heldItemId, itemUsed } from "./use.js";
import { registerWorldData } from "./world-data.js";
import type { WorldDataSet } from "./world-data.js";
import { dropped, granted, landed, pickedUp } from "./world-items.js";

/** State the engine itself keeps on every player or once for the world, and events it sends, under one name. */
interface BuiltIn {
  readonly player?: PlayerData<unknown>;
  readonly world?: WorldDataSet;
  readonly events?: ContentEvents;
}

/**
 * The engine's own state and events, by the name each travels under. Every session has them,
 * under `core/`, a namespace content names cannot take.
 */
const BUILT_INS: Readonly<Record<`core/${string}`, BuiltIn>> = {
  /** The id of the item each player holds, and each use of it. */
  "core/items": { player: heldItemId, events: { use: itemUsed } },
  /** How each player moves, which its footsteps follow. */
  "core/movement": { player: movement },
  /** Each noise the host makes, made again on every client. */
  "core/noise": { events: { made: noiseMade } },
  /** The blows the host deals each player, damage and any push, sent to that player's own client. */
  "core/health": { events: { damage: damaged } },
  /** Where the host puts a player whose own client has it somewhere else. */
  "core/position": { events: { corrected } },
  /**
   * Items lying in the world: each pickup and drop the host checks, the item it grants, and each
   * item it lays down.
   */
  "core/world-items": { events: { pickedUp, granted, dropped, landed } },
  /** The latest action the host has handled from each player, which ends what that player's client predicted. */
  "core/predictions": { world: { handled: handledActions } },
};

/** Registers the engine's own state and events with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, { player, world, events }] of Object.entries(BUILT_INS)) {
    if (player !== undefined) registerPlayerData(game, name, player);
    if (world !== undefined) registerWorldData(game, name, world);
    if (events !== undefined) registerEvents(game, name, events);
  }
}
