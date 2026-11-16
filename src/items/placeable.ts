import { defineItem, effect, sound } from "../sim/index.js";
import type {
  Content,
  ItemTraits,
  Player,
  Point,
  Session,
} from "../sim/index.js";

/** A thing carried to be put down in the world, such as a stun trap, a turret or a teleporter. */
export interface PlaceableConfig extends ItemTraits {
  /** Least time between two uses, in sim seconds. */
  readonly cooldown: number;
  /** Volume of setting it down, 0..1. */
  readonly volume: number;
  /** How far, in pixels, setting it down is heard, and so how far its noise carries. */
  readonly placeNoiseRadius: number;
}

/** What sets one placeable apart: its name and glyph, the sound of setting it down, and its put. */
interface Placing {
  readonly name: string;
  readonly emoji: string;
  /** The sound of setting it down; silent when left out, its noise carrying all the same. */
  readonly placeUrl?: string;
  /**
   * Puts it down for `user`, which faces `aim` in radians, which only the host does; returns
   * where it lies, for the sound of setting it down.
   */
  place(game: Session, user: Player, aim: number): Point;
}

/**
 * A placeable item, registered as `id`: the use control puts it down by its holder, the way it
 * aims, and its one use is spent doing so. Setting it down is heard close by.
 */
export function definePlaceable<N extends string>(
  id: N,
  placing: Placing,
): Content<N, PlaceableConfig> {
  return defineItem(id, (config: PlaceableConfig) => {
    const thud =
      placing.placeUrl === undefined
        ? undefined
        : sound({
            url: placing.placeUrl,
            volume: config.volume,
            range: config.placeNoiseRadius,
          });
    return {
      name: placing.name,
      emoji: placing.emoji,
      traits: config,
      use: {
        cooldown: config.cooldown,
        apply(game, user, { aim }) {
          const at = placing.place(game, user, aim);
          effect(game, {
            at,
            noise: config.placeNoiseRadius,
            ...(thud !== undefined && { sound: thud }),
          });
        },
      },
      draw() {
        // Putting it down shows only as the thing it leaves.
      },
    };
  });
}
