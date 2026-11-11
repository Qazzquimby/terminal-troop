import type { Point } from "./map.js";
import type { Session } from "./session.js";

/** A blow seen landing on this client: where, how wide, and whether it connected. */
export interface Flash {
  readonly at: Point;
  readonly radius: number;
  readonly hit: boolean;
}

/** Shows `flash` for the rest of this step, on this client alone. */
export function showFlash(game: Session, flash: Flash): void {
  game.flashes.push(flash);
}
