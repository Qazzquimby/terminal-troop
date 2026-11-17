import { livingPlayers } from "./ghosts.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/*
 * A body inside a vehicle does not move about the world: nothing bumps into it, and it does not
 * look out at anything. Whether the world can get at it depends on the vehicle's door. Behind a
 * closed door, or in a vehicle without one, it is shut away: nothing out there sees, targets,
 * strikes or traps it. Through an open door it is in reach like any body out in the world, where
 * the vehicle is. Either way, what it says or does that makes a noise is heard from there, and can
 * draw whatever hears it. Rules that move bodies about go over `playersOutside`; rules that see,
 * target or hurt them go over `livingBodies`, which leaves out only those shut away, whatever kind
 * of body it is.
 */

/** Whether `body` is inside a vehicle. Any body with a ride counts, not only a player. */
export const isAboard = (body: object): boolean =>
  "ride" in body && body.ride !== null && body.ride !== undefined;

/**
 * Whether `body` is inside a vehicle and shut away from the world: the vehicle has no door, or its
 * door is closed, as this client has it. One in a vehicle this client does not know is shut away.
 */
export function isShutIn(game: Session, body: object): boolean {
  if (!("ride" in body)) return false;
  const { ride } = body;
  if (typeof ride !== "object" || ride === null || !("vehicle" in ride))
    return false;
  if (typeof ride.vehicle !== "string") return true;
  const vehicle = game.entities.get(ride.vehicle);
  if (vehicle === undefined) return true;
  const door = game.entityTypes.get(vehicle.kind)?.vehicle?.door;
  return door === undefined || door.closed(vehicle);
}

/** Every living player out in the world: not a ghost, and not inside a vehicle. */
export const playersOutside = (game: Session): Player[] =>
  livingPlayers(game).filter((player) => !isAboard(player));

/**
 * Every living player the world can get at: not a ghost, and not shut away inside a vehicle, so
 * one behind an open door counts.
 */
export const playersExposed = (game: Session): Player[] =>
  livingPlayers(game).filter((player) => !isShutIn(game, player));
