import { placeStunTrap } from "../../entities/index.js";
import { defineItem, effect } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";
// The click of it being set down, once its asset lands; importing a missing file breaks the build.
// import placeUrl from "./sfx/place.mp3";

/** A stun trap carried: used once, it is put down where its holder stands. */
export interface StunTrapItemConfig extends ItemTraits {
  /** Least time between two uses, in sim seconds. */
  readonly cooldown: number;
  /** Volume of setting it down, 0..1. */
  readonly volume: number;
  /** How far, in pixels, setting it down is heard, and so how far its noise carries. */
  readonly placeNoiseRadius: number;
}

/**
 * A stun trap: the use control puts it down at its holder's feet, where it arms and waits for
 * something to step on it. Its one use is spent putting it down.
 */
export const stunTrap = defineItem("stunTrap", (config: StunTrapItemConfig) => {
  // const place = sound({ url: placeUrl, volume: config.volume, range: config.placeNoiseRadius });
  return {
    name: "Stun Trap",
    emoji: "🪤",
    traits: config,
    use: {
      cooldown: config.cooldown,
      apply(game, user) {
        const at = { x: user.x, y: user.y };
        placeStunTrap(game, at);
        effect(game, {
          at,
          noise: config.placeNoiseRadius /* , sound: place */,
        });
      },
    },
    draw() {
      // Putting it down shows only as the trap it leaves.
    },
  };
});
