import { actionEvents, registerActions } from "./actions.js";
import type { Action } from "./actions.js";
import { registerEvents } from "./content-event.js";
import { doorActions } from "./door-actions.js";
import type { ContentEvents } from "./content-event.js";
import { playerHealth } from "./health.js";
import { falls, rises } from "./fallen.js";
import { lastHurts } from "./hurts.js";
import { movement } from "./movement.js";
import { registerPlayerData } from "./player-data.js";
import type { PlayerData } from "./player-data.js";
import { handledActions } from "./prediction.js";
import type { Session } from "./session.js";
import { bodyStatuses } from "./status.js";
import { steeringEvents } from "./steering.js";
import { heldSlot, inventories, stores } from "./inventories.js";
import { credit } from "./credit.js";
import { registerWorldData } from "./world-data.js";
import type { WorldDataSet } from "./world-data.js";
import { voiceNoise } from "./voice-noise.js";
import { clipsHeld, echoEvents } from "./echoes.js";
import { addVoiceChannel, onAir } from "./voice-routes.js";
import type { VoiceChannel } from "./voice-routes.js";
import { bodies, ghostVoices } from "./death.js";
import { drop, pickUp } from "./world-items.js";
import { vehicleActions } from "./vehicle.js";
import { destroyedWalls } from "./walls.js";

/**
 * State the engine itself keeps on every player or once for the world, and events and actions it
 * sends, under one name.
 */
interface BuiltIn {
  readonly player?: PlayerData<unknown>;
  readonly world?: WorldDataSet;
  readonly events?: ContentEvents;
  readonly actions?: readonly Action<never>[];
  readonly voice?: VoiceChannel;
}

/**
 * The engine's own state and events, by the name each travels under. Every session has them,
 * under `core/`, a namespace content names cannot take.
 */
const BUILT_INS: Readonly<Record<`core/${string}`, BuiltIn>> = {
  /**
   * The slot each player holds, every player's items as the host keeps them, and the stores of
   * items kept by anything else, such as a vehicle.
   */
  "core/items": { player: heldSlot, world: { inventories, stores } },
  /** The team's credit, earned selling scrap and spent at a vehicle's shop. */
  "core/team": { world: { credit } },
  /** How each player moves, which its footsteps follow. */
  "core/movement": { player: movement },
  /** How far each player's speech carries, which its voice noise follows. */
  "core/voice": { player: voiceNoise },
  /** Whether each player is on the air, its voice going past the air through a channel. */
  "core/on-air": { player: onAir },
  /**
   * How many clips of its own speech each player's client holds, and how an entity speaking in a
   * player's voice gets one played.
   */
  "core/echoes": { player: clipsHeld, events: echoEvents },
  /** Each player's health, which the host alone changes. */
  "core/health": { world: { players: playerHealth } },
  /** The statuses each body, player or entity, is under, such as stunned, and when each ends. */
  "core/statuses": { world: { bodies: bodyStatuses } },
  /**
   * Who last hurt each body, players and world entities alike, and when; and the latest bodies
   * to fall, and to what.
   */
  "core/hurts": { world: { last: lastHurts, fallen: falls } },
  /**
   * Every fallen player's body, lying as a corpse; the latest bodies brought back, and by what;
   * and how ghosts hear each other.
   */
  "core/death": { world: { bodies, risen: rises }, voice: ghostVoices },
  /** What each player steers with, sent to the host as it changes. */
  "core/steering": { events: steeringEvents },
  /** Items lying in the world, picked up and dropped. */
  "core/world-items": { actions: [pickUp, drop] },
  /** Getting in and out of vehicles. */
  "core/vehicles": { actions: vehicleActions },
  /** The walls knocked down since the world was laid, which every client clears from its map. */
  "core/walls": { world: { destroyed: destroyedWalls } },
  /** The latest action the host has handled from each player, which ends what that player's client predicted. */
  "core/predictions": { world: { handled: handledActions } },
  /**
   * What each action the host applied, or each entity on the host, shows and sounds, and the
   * noise it makes.
   */
  "core/actions": { events: actionEvents },
  /** Opening and closing doors. */
  "core/doors": { actions: doorActions },
};

/** Registers the engine's own state, events and actions with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, built] of Object.entries(BUILT_INS)) {
    const { player, world, events, actions, voice } = built;
    if (voice !== undefined) addVoiceChannel(game, voice);
    if (player !== undefined) registerPlayerData(game, name, player);
    if (world !== undefined) registerWorldData(game, name, world);
    if (events !== undefined) registerEvents(game, name, events);
    if (actions !== undefined) registerActions(game, name, actions);
  }
}
