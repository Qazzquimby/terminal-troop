import { CORPSE_ITEM, effect, itemInstances, revive } from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
// The revival's sound, once its asset lands; importing a missing file breaks the build.
// import reviveUrl from "./sfx/revive.mp3";

/** How a corpse brought to the cruiser comes back to life. */
export interface ReviveConfig {
  /** How near the cruiser's body a player carrying a corpse must come, in pixels. */
  readonly reach: number;
  /** Volume of the revival's sound, 0..1. */
  readonly volume: number;
}

/** How wide a revived player's flash is, in its own radii. */
const REVIVE_FLASH = 3;

/**
 * The cruiser's revival rule, run on the host each step: a corpse brought within reach of the
 * cruiser by a player carrying it is gone, and its player stands by the cruiser alive again.
 * `cruiserBy` finds the cruiser within reach of the carrier, if any.
 */
export function stepRevival(
  game: Session,
  cruiserBy: (at: Point & { readonly radius: number }) => WorldEntity | null,
): void {
  for (const corpse of itemInstances(game, CORPSE_ITEM)) {
    const { place } = corpse;
    // Only one brought there counts: a player who falls by the cruiser is not back at once.
    if ("lying" in place) continue;
    const cruiser = cruiserBy(place.carrier);
    if (cruiser === null) continue;
    const revived = revive(game, corpse.state, cruiser, place.carrier.id);
    if (revived === null) continue;
    effect(
      game,
      {
        at: { x: revived.x, y: revived.y },
        flash: { radius: revived.radius * REVIVE_FLASH, hit: false },
        // sound: sound({ url: reviveUrl, volume: config.volume }),
      },
      cruiser,
    );
  }
}
