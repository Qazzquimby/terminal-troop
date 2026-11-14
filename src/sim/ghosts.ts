import type { Player } from "./player.js";
import type { Session } from "./session.js";

/*
 * A player whose health has run out is a ghost until revived. A ghost stays in the session, so it
 * keeps its voice and watches the others, but it never touches the world: nothing sees, hears,
 * strikes, targets or bumps into it, and it does not act. Anything that goes over the players to
 * act on them, such as a monster hunting, a trap springing or one frozen while watched, goes over
 * `livingPlayers` rather than every player.
 */

/** Whether `player` is a ghost: its health on the host's record has run out. */
export const isGhost = (player: Pick<Player, "health">): boolean =>
  player.health <= 0;

/** Every player in the session that is not a ghost. */
export const livingPlayers = (game: Session): Player[] =>
  [...game.players.values()].filter((player) => !isGhost(player));

/** Whether `id` is a ghost among the session's players. */
export function isGhostId(game: Session, id: string | undefined): boolean {
  if (id === undefined) return false;
  const player = game.players.get(id);
  return player !== undefined && isGhost(player);
}
