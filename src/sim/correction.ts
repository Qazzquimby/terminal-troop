import { z } from "zod";
import { canStandAt } from "./arrival.js";
import { nearestFreePoint } from "./collision.js";
import { contentEvent } from "./content-event.js";
import { snapPrevious } from "./interpolation.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

const Corrected = z.object({ x: z.number(), y: z.number() });

/**
 * Puts `player` at `at` at once: at rest, any dash dropped, and drawn there rather than sliding
 * from where it was.
 */
function placeAt(player: Player, at: Point): void {
  player.x = player.tx = at.x;
  player.y = player.ty = at.y;
  player.vx = 0;
  player.vy = 0;
  player.dash = null;
  snapPrevious(player);
}

/** Puts the local player where the host says it is, and tells the room at once. */
function takeCorrection(game: Session, at: Point): void {
  placeAt(game.local, at);
  game.reportNow = true;
}

/** Where the host puts one player, for that player's own client to take. */
export const corrected = contentEvent({
  schema: Corrected,
  to: "player",
  from: "host",
  receive: takeCorrection,
});

/**
 * Moves `player` to `at` as the host, or to the nearest point a player can stand when `at` is
 * blocked. An `at` that is not a finite point is ignored. The local player moves at once. A
 * remote player is sent where to stand, and its copy here stands there until its next STATE, so
 * the host sees and hits it there meanwhile.
 *
 * A STATE the player sent before the correction reached it can still arrive afterwards, and puts
 * the copy here back at the old position until the corrected STATE follows, about a round trip
 * later. Checks on reported positions should allow for that rather than correct again.
 */
export function correctPlayer(game: Session, player: Player, at: Point): void {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
  const { radius } = game.config.player;
  const to = canStandAt(game.world, at, radius)
    ? { x: at.x, y: at.y }
    : nearestFreePoint(game.world.map, radius, at);
  if (player === game.local) takeCorrection(game, to);
  else if (game.players.get(player.id) === player) {
    placeAt(player, to);
    corrected.send(game, player.id, to);
  }
}
