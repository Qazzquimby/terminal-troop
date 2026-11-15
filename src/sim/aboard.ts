import { livingPlayers } from "./ghosts.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/*
 * A body inside a vehicle is shut away from the world outside: nothing out there sees, targets,
 * strikes, traps or bumps into it, and it does not look out at anything either. It is still where
 * the vehicle is, so what it says or does that makes a noise is heard from there, and can draw
 * whatever hears it. Rules that go over the bodies out in the world leave it out through
 * `livingBodies` and `playersOutside`, whatever kind of body it is.
 */

/** Whether `body` is inside a vehicle. Any body with a ride counts, not only a player. */
export const isAboard = (body: object): boolean =>
  "ride" in body && body.ride !== null && body.ride !== undefined;

/** Every living player out in the world: not a ghost, and not inside a vehicle. */
export const playersOutside = (game: Session): Player[] =>
  livingPlayers(game).filter((player) => !isAboard(player));
