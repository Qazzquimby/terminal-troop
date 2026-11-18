import {
  effect,
  hasKindTag,
  INERT_TAG,
  sound,
  spawnWorldItem,
  watchFalls,
} from "../../sim/index.js";
import type { Point, Session } from "../../sim/index.js";
import { defineScrap } from "../scrap/index.js";
import type { ScrapConfig } from "../scrap/index.js";
// Plain scrap's sounds until the heart's own arrive; swap these imports for the ones below.
import cashoutUrl from "../scrap/sfx/cashout.mp3";
import dropUrl from "../scrap/sfx/drop.mp3";
// import cashoutUrl from "./sfx/cashout.mp3";
// import dropUrl from "./sfx/drop.mp3";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const tearUrl = new URL("./sfx/tear.mp3", import.meta.url).href;

/** A heart: scrap torn from a tough body as it falls. */
export interface HeartConfig extends ScrapConfig {
  /**
   * The least full health a body must have for a heart to drop where it falls: any living body,
   * players and world entities alike, with a finite full health this high or higher. An inert
   * body (`INERT_TAG`), such as a door, is not alive and never drops one.
   */
  readonly toughness: number;
  /** How far the wet thud of a heart dropping where a body falls is heard, in pixels. */
  readonly tearRange: number;
}

const ITEM = "heart";

/** The red it glows and glints in. */
const RED = "#ff3355";

/** How wide the flash of a heart dropping is, in pixels. */
const TEAR_FLASH = 18;

/** The spots, per session on the host, where a heart is due to drop, as bodies fell this step. */
const due = new WeakMap<Session, Point[]>();

/**
 * The heart: drops where any living (not inert) body falls whose full health is the item's toughness or more, as
 * hard to kill as a sleeper, say. Sold at the cruiser as any scrap is; offered at a shrine, it
 * brings back a ghost.
 */
export const heart = defineScrap(
  ITEM,
  { name: "Heart", emoji: "❤️", glint: RED, cashoutUrl, dropUrl },
  (config: HeartConfig) => {
    const tear = sound({
      url: tearUrl,
      volume: config.volume,
      range: config.tearRange,
    });
    return {
      register(game) {
        watchFalls(game, (_game, victim) => {
          if (!Number.isFinite(victim.maxHealth)) return;
          if (victim.maxHealth < config.toughness) return;
          // Not alive, so nothing to tear out: a door, a turret.
          if (hasKindTag(game, victim.id, [INERT_TAG])) return;
          due.set(game, [
            ...(due.get(game) ?? []),
            { x: victim.x, y: victim.y },
          ]);
        });
      },
      step(game) {
        const spots = due.get(game);
        if (spots === undefined) return;
        due.delete(game);
        for (const at of spots) {
          const dropped = spawnWorldItem(game, at, ITEM);
          effect(
            game,
            { at, sound: tear, flash: { radius: TEAR_FLASH, hit: true } },
            dropped,
          );
        }
      },
    };
  },
);
