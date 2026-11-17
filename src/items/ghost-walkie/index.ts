import {
  defineItem,
  effect,
  ghostEarChannel,
  isOn,
  itemInstances,
  setStateAt,
  sound,
  stateAt,
} from "../../sim/index.js";
import type { ItemTraits } from "../../sim/index.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const dropUrl = new URL("./sfx/drop.mp3", import.meta.url).href;
const onUrl = new URL("./sfx/on.mp3", import.meta.url).href;
const offUrl = new URL("./sfx/off.mp3", import.meta.url).href;

/** The ghost walkie. Distances in pixels, times in sim seconds. */
export interface GhostWalkieConfig extends ItemTraits {
  /** How near it a living speaker must be for the ghosts to hear it. */
  readonly reach: number;
  /** How far switching it on or off is heard, and so how far that noise carries. */
  readonly switchRange: number;
  /** Least time between one player's switches of it. */
  readonly cooldown: number;
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

const GHOST_WALKIE_ITEM = "ghostWalkie";

/** The pale blue it glints in. */
const PALE = "#9fe3ff";

/**
 * The ghost walkie, made by offering a walkie at a shrine: E switches it on or off, held or not.
 * While it is on, wherever it is, carried or lying, it is a ghost ear: every ghost's voice plays
 * from it as through a small speaker, and every ghost hears whoever speaks within its reach. It
 * never runs down.
 */
export const ghostWalkie = defineItem(
  GHOST_WALKIE_ITEM,
  (config: GhostWalkieConfig) => {
    const sounds = {
      on: sound({
        url: onUrl,
        volume: config.volume,
        range: config.switchRange,
      }),
      off: sound({
        url: offUrl,
        volume: config.volume,
        range: config.switchRange,
      }),
    };
    return {
      name: "Ghost walkie",
      emoji: "📟",
      glint: PALE,
      traits: config,
      drop: sound({ url: dropUrl, volume: config.volume }),
      voice: ghostEarChannel((game) =>
        itemInstances(game, GHOST_WALKIE_ITEM)
          .filter((instance) => isOn(instance.state))
          .map((instance) => ({
            at: instance.at,
            via: "radio" as const,
            reach: config.reach,
          })),
      ),
      control: {
        cooldown: config.cooldown,
        apply(game, user, { slot }) {
          const on = !isOn(stateAt(game, user, slot));
          setStateAt(
            game,
            user,
            slot,
            GHOST_WALKIE_ITEM,
            on ? { on: true } : undefined,
          );
          effect(game, {
            at: { x: user.x, y: user.y },
            sound: on ? sounds.on : sounds.off,
          });
        },
      },
    };
  },
);
