import type { ItemUse, Session } from "../sim/index.js";

/** What a usable item does; each usable item supplies one, keyed by its id. */
export interface ItemBehaviour {
  /** Minimum time between uses, in milliseconds. */
  readonly cooldownMs: number;
  /** Starts a use at `now`, or returns null when the item cannot be used. */
  use(game: Session, now: number): ItemUse | null;
}
