import { registerPlayerData } from "./player-data.js";
import type { Session } from "./session.js";
import { heldItemId } from "./use.js";

/**
 * The state the engine itself keeps on every player, by the name it travels under. Every
 * session has it, and content may not use these names.
 */
const BUILT_IN_DATA = {
  /** The id of the item each player holds. */
  held: heldItemId,
} as const;

export const RESERVED_NAMES: ReadonlySet<string> = new Set(
  Object.keys(BUILT_IN_DATA),
);

/** Registers the engine's own player state with a new session. */
export function registerBuiltIns(game: Session): void {
  for (const [name, data] of Object.entries(BUILT_IN_DATA))
    registerPlayerData(game, name, data);
}
