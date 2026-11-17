import {
  CORPSE_ITEM,
  credit,
  effect,
  itemInstances,
  revive, sound,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
import reviveUrl from "./sfx/revive.mp3";

/** How a corpse brought to the cruiser comes back to life. */
export interface ReviveConfig {
  /** How near the cruiser's body a player carrying a corpse must come, in pixels. */
  readonly reach: number;
  /** Volume of the revival's sound, 0..1. */
  readonly volume: number;
  /** Credit a revival costs the team; it is spent even if that puts the team in debt. */
  readonly cost: number;
}

/** How wide a revived player's flash is, in its own radii. */
const REVIVE_FLASH = 3;

/**
 * The cruiser's revival rule, run on the host each step: a corpse brought within reach of the
 * cruiser by a player carrying it is gone, and its player stands by the cruiser alive again, at
 * the cost of `config.cost` of the team's credit, into debt if the team has less.
 * `cruiserBy` finds the cruiser within reach of the carrier, if any.
 */
export function stepRevival(
  game: Session,
  config: ReviveConfig,
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
    credit.set(game, credit.get(game) - config.cost);
    effect(
      game,
      {
        at: { x: revived.x, y: revived.y },
        flash: { radius: revived.radius * REVIVE_FLASH, hit: false },
        sound: sound({ url: reviveUrl, volume: config.volume }),
      },
      cruiser,
    );
  }
}
