import { registerPlayerData } from "./player-data.js";
import type { Session } from "./session.js";
import { heldItemId } from "./use.js";

/**
 * The state the engine itself keeps on every player, by the name it travels under. Every
 * session has it, under `core/`, a namespace content names cannot take.
 */
const BUILT_IN_DATA = {
  /** The id of the item each player holds. */
  "core/items": heldItemId,
} as const;

/** Registers the engine's own player state with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, data] of Object.entries(BUILT_IN_DATA))
    registerPlayerData(game, name, data);
}
