import type { ItemEffect, ItemUse, Session } from "../sim/index.js";

/** What a usable item does; each usable item supplies one, keyed by its id. */
export interface ItemBehaviour extends ItemEffect {
  /** Shows the local player's use starting at `now`, as this client sees it. */
  show(game: Session, now: number): ItemUse;
}
