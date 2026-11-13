import { actionEvents, forcedMoveEvents, registerActions } from "./actions.js";
import type { Action } from "./actions.js";
import { registerEvents } from "./content-event.js";
import type { ContentEvents } from "./content-event.js";
import { forcedMoves } from "./forced-move.js";
import { playerHealth } from "./health.js";
import { movement } from "./movement.js";
import { noiseMade } from "./noise.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import { handledActions } from "./prediction.js";
import type { Session } from "./session.js";
import { heldSlot, inventories } from "./inventories.js";
import { registerWorldData } from "./world-data.js";
import type { WorldDataSet } from "./world-data.js";
import { voiceNoise } from "./voice-noise.js";
import { drop, pickUp } from "./world-items.js";

/**
 * State the engine itself keeps on every player or once for the world, and events and actions it
 * sends, under one name.
 */
interface BuiltIn {
  readonly player?: PlayerData<unknown>;
  readonly world?: WorldDataSet;
  readonly events?: ContentEvents;
  readonly actions?: readonly Action<never>[];
}

/**
 * The engine's own state and events, by the name each travels under. Every session has them,
 * under `core/`, a namespace content names cannot take.
 */
const BUILT_INS: Readonly<Record<`core/${string}`, BuiltIn>> = {
  /** The slot each player holds, and every player's items as the host keeps them. */
  "core/items": { player: heldSlot, world: { inventories } },
  /** How each player moves, which its footsteps follow. */
  "core/movement": { player: movement },
  /** How far each player's speech carries, which its voice noise follows. */
  "core/voice": { player: voiceNoise },
  /** Each noise the host makes, made again on every client. */
  "core/noise": { events: { made: noiseMade } },
  /** Each player's health, which the host alone changes. */
  "core/health": { world: { players: playerHealth } },
  /**
   * Each move the host forces on a player, a correction or a knockback, and the latest on each
   * player for clients that missed it.
   */
  "core/position": {
    events: forcedMoveEvents,
    world: { forced: forcedMoves },
  },
  /** Items lying in the world, picked up and dropped. */
  "core/world-items": { actions: [pickUp, drop] },
  /** The latest action the host has handled from each player, which ends what that player's client predicted. */
  "core/predictions": { world: { handled: handledActions } },
  /** What each action the host applied shows and sounds, and the noise it makes. */
  "core/actions": { events: actionEvents },
};

/** Registers the engine's own state, events and actions with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, built] of Object.entries(BUILT_INS)) {
    const { player, world, events, actions } = built;
    if (player !== undefined) registerPlayerData(game, name, player);
    if (world !== undefined) registerWorldData(game, name, world);
    if (events !== undefined) registerEvents(game, name, events);
    if (actions !== undefined) registerActions(game, name, actions);
  }
}
