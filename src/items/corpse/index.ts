import { CORPSE_ITEM, defineItem } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";
// The thud of a body falling or being put down, once its asset lands; importing a missing file
// breaks the build.
// import thudUrl from "./sfx/thud.mp3";

/** A fallen player's body, carried back to the cruiser to revive it. */
export interface CorpseConfig extends ItemTraits {
  /** Volume of its thud, 0..1. */
  readonly volume: number;
}

/**
 * A corpse: what a fallen player's body lies as, named after whose it is. Never laid as loot and
 * never carried from the start; it lies where its player fell, and is heavy. Brought to the
 * cruiser, its player comes back to life.
 */
export const corpse = defineItem(CORPSE_ITEM, (config: CorpseConfig) => ({
  name: "Corpse",
  emoji: "⚰️",
  // drop: sound({ url: thudUrl, volume: config.volume }),
  traits: config,
}));
