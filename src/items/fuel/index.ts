import { nearCruiser, refuel } from "../../entities/index.js";
import { defineItem, effect, take } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";
// Its pour into the cruiser and its thud on the ground, once their assets land; importing a
// missing file breaks the build. Until then it pours and lands silently.
// import pourUrl from "./sfx/pour.mp3";
// import dropUrl from "./sfx/drop.mp3";

/** A can of fuel: heavy, and what the cruiser runs on. */
export interface FuelConfig extends ItemTraits {
  /** Seconds of driving one can gives the cruiser. */
  readonly seconds: number;
  /** How far past touching the cruiser's body its holder may pour it in, in pixels. */
  readonly reach: number;
  /** Least time between one player's uses, in sim seconds. */
  readonly cooldown: number;
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

const ITEM = "fuel";

/**
 * Fuel: used beside the cruiser, the can is poured in, gone from its holder's items, and the
 * cruiser has that much more driving in it, its crash damage mended; once it has any fuel, its
 * engine runs and it can be driven.
 * Used anywhere else, it does nothing.
 */
export const fuel = defineItem(ITEM, (config: FuelConfig) => {
  // const pour = sound({ url: pourUrl, volume: config.volume });
  return {
    name: "Fuel",
    emoji: "⛽",
    traits: config,
    // drop: sound({ url: dropUrl, volume: config.volume }),
    use: {
      cooldown: config.cooldown,
      apply(game, user, { slot }) {
        const cruiser = nearCruiser(game, user, config.reach);
        if (cruiser === null) return;
        if (take(game, user, slot, ITEM) === null) return;
        refuel(game, cruiser, config.seconds);
        effect(game, {
          at: { x: user.x, y: user.y },
          flash: { radius: user.radius * 2, hit: true },
          // sound: pour,
        });
      },
    },
    draw() {
      // A pour shows as its flash; the can draws nothing of its own.
    },
  };
});
