import { z } from "zod";
import { solidBodiesBut } from "./collision.js";
import { contentEvent } from "./content-event.js";
import { applyDamage } from "./entity.js";
import { forcePlayer } from "./forced-move.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import { dashEnd } from "./player.js";
import type { Session } from "./session.js";

/** A push on a player: `distance` pixels straight away from `from`. */
export interface Push {
  readonly from: Point;
  readonly distance: number;
}

/** A blow as its player takes it: its damage. */
const Blow = z.object({ amount: z.number().positive() });

/** A blow the host deals one player, for that player's own client to take. */
export const damaged = contentEvent({
  schema: Blow,
  to: "player",
  from: "host",
  receive(game, { amount }) {
    applyDamage(game.local, amount);
    game.reportNow = true;
  },
});

/**
 * As the host, knocks `player` along `push`, as far as walls and other bodies let it go from
 * where the host sees it, sliding there over the configured knockback time on every client.
 * A push from where the player stands has no way to go, and is dropped.
 */
function knockPlayer(game: Session, player: Player, push: Push): void {
  const dx = player.x - push.from.x;
  const dy = player.y - push.from.y;
  if (push.distance <= 0 || (dx === 0 && dy === 0)) return;
  const to = dashEnd(
    player,
    Math.atan2(dy, dx),
    push.distance,
    game.world.map,
    solidBodiesBut(game, player),
  );
  forcePlayer(game, player, to, {
    seconds: game.config.player.knockbackSeconds,
  });
}

/**
 * Deals `amount` damage to `player`, and `push` if given, as the host. The local player takes
 * the damage at once, and a remote one is sent it, since each player keeps its own health. The
 * push is a move the host forces on the player.
 */
export function hurtPlayer(
  game: Session,
  player: Player,
  amount: number,
  push?: Push,
): void {
  if (game.players.get(player.id) !== player) return;
  if (amount > 0) {
    if (player === game.local) applyDamage(player, amount);
    else damaged.send(game, player.id, { amount });
  }
  if (push !== undefined) knockPlayer(game, player, push);
}
