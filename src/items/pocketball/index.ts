import {
  POCKETBALL_ITEM,
  pocketballGlyph,
  pocketOf,
  throwPocketball,
} from "../../entities/index.js";
import { defineItem, effect, sound, stateAt, take } from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const throwUrl = new URL("./sfx/throw.mp3", import.meta.url).href;
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;

/** The pocketball, as an item. Distances in pixels, times in sim seconds. */
export interface PocketballItemConfig extends ItemTraits {
  /** Least time between one player's throws. */
  readonly cooldown: number;
  /** How far a throw flies in all, bounces included, before the ball drops. */
  readonly range: number;
  /** Volume of throwing it and of it dropping, 0..1. */
  readonly volume: number;
  /** How far throwing it is heard, and so how far that noise carries. */
  readonly throwNoiseRadius: number;
  /** How far it dropping to the ground is heard. */
  readonly dropNoiseRadius: number;
}

const ITEM = POCKETBALL_ITEM;

/**
 * The pocketball: the use control throws it the way its holder aims, bouncing off walls. Empty, it
 * catches the first body it touches that it can, players included, into a pocket off the map, and
 * drops there full; full, it lets that body out where it lands or strikes, and is spent. It keeps
 * its pocket wherever it goes, carried, dropped, picked up by anyone or stowed, and shows white
 * when empty, red when full.
 */
export const pocketball = defineItem(ITEM, (config: PocketballItemConfig) => {
  const volume = config.volume;
  const thrown = sound({
    url: throwUrl,
    volume,
    range: config.throwNoiseRadius,
  });
  return {
    name: "Pocketball",
    emoji: pocketballGlyph(null),
    emojiFor: (state) => pocketballGlyph(pocketOf(state)),
    traits: config,
    drop: sound({ url: dropUrl, volume, range: config.dropNoiseRadius }),
    use: {
      cooldown: config.cooldown,
      apply(game, user, { slot, aim }) {
        const pocket = pocketOf(stateAt(game, user, slot));
        if (take(game, user, slot, ITEM) === null) return;
        throwPocketball(game, user, { aim, range: config.range, pocket });
        effect(game, { at: { x: user.x, y: user.y }, sound: thrown });
      },
    },
    draw() {
      // A throw shows only as the ball in flight.
    },
  };
});
