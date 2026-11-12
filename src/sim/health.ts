import { z } from "zod";
import { solidBodiesBut } from "./collision.js";
import { contentEvent } from "./content-event.js";
import { applyDamage } from "./entity.js";
import type { Point } from "./map.js";
import { allowMove } from "./move-checks.js";
import type { Player } from "./player.js";
import { startDash } from "./player.js";
import type { Session } from "./session.js";

/** A push on a player: `distance` pixels straight away from `from`. */
export interface Push {
  readonly from: Point;
  readonly distance: number;
}

/** A blow as its player takes it: damage, and the way and length of any push, `aim` in radians. */
const Blow = z.object({
  amount: z.number().nonnegative(),
  push: z
    .object({ aim: z.number(), distance: z.number().positive() })
    .optional(),
});
type Blow = z.infer<typeof Blow>;

/**
 * Takes `blow` on the local player: its damage at once, and its push as a slide over the
 * configured knockback time that stops at walls and short of other bodies.
 */
function takeBlow(game: Session, { amount, push }: Blow): void {
  const { local } = game;
  applyDamage(local, amount);
  if (push === undefined) return;
  startDash(
    local,
    push.aim,
    push.distance,
    game.config.player.knockbackSeconds,
    game.world.map,
    solidBodiesBut(game, local),
  );
}

/** A blow the host deals one player, for that player's own client to take. */
export const damaged = contentEvent({
  schema: Blow,
  to: "player",
  from: "host",
  receive(game, blow) {
    takeBlow(game, blow);
    game.reportNow = true;
  },
});

/**
 * Deals `amount` damage to `player`, and `push` if given, as the host: the local player takes it
 * at once, and a remote one is sent it, since each player keeps its own health and position. A
 * push from where the player stands has no way to go, and is dropped. A blow of neither damage
 * nor push does nothing.
 */
export function hurtPlayer(
  game: Session,
  player: Player,
  amount: number,
  push?: Push,
): void {
  const dx = push === undefined ? 0 : player.x - push.from.x;
  const dy = push === undefined ? 0 : player.y - push.from.y;
  const blow: Blow = {
    amount: Math.max(0, amount),
    ...(push !== undefined &&
      push.distance > 0 &&
      (dx !== 0 || dy !== 0) && {
        push: { aim: Math.atan2(dy, dx), distance: push.distance },
      }),
  };
  if (blow.amount === 0 && blow.push === undefined) return;
  if (player === game.local) takeBlow(game, blow);
  else if (game.players.get(player.id) === player) {
    if (blow.push !== undefined)
      allowMove(
        game,
        player.id,
        blow.push.distance,
        game.config.player.knockbackSeconds,
      );
    damaged.send(game, player.id, blow);
  }
}
