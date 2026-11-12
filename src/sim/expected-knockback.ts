import { solidBodiesBut } from "./collision.js";
import { correctPlayer } from "./correction.js";
import type { Point } from "./map.js";
import { movement } from "./movement.js";
import type { Player } from "./player.js";
import { dashEnd, speedFactor } from "./player.js";
import type { Session } from "./session.js";

/** How the host checks that a remote player it pushed took the push. */
export interface KnockbackCheck {
  /**
   * Seconds the host waits past the push's own length before checking: room for the push to
   * reach the player and for its report of where it ended to come back.
   */
  readonly slack: number;
  /**
   * How far, in pixels, a player's reported position may be from where the push leaves it, on
   * top of how far the player could have moved itself since the push.
   */
  readonly tolerance: number;
}

/**
 * A push the host has sent a remote player, as the host expects it to play out. The host keeps
 * one per pushed player, by id, until `until`, and only while hosting. A later push before then
 * replaces it, starting from its `at`.
 */
export interface ExpectedKnockback {
  /** Where the push leaves the player, worked out from the host's own view of it. */
  readonly at: Point;
  /** The sim time by which the player's reports should show it near `at`. */
  readonly until: number;
  /**
   * The fastest, in pixels per second, the player has reported moving under its own power since
   * the push, as its gait and speed config give it; 0 while it reports standing still.
   */
  readonly pace: number;
}

/** How fast `player` reports moving under its own power, in pixels per second. */
function paceOf(game: Session, player: Player): number {
  const { mode, moving } = movement.get(player);
  const { player: config } = game.config;
  return moving ? config.speed * speedFactor(mode, config) : 0;
}

/**
 * Records, as the host, a push of `distance` pixels towards `aim` (radians) sent to the remote
 * `player`. It ends where the player's own dash would, from where the player last reported
 * standing, or from the end of a push still expected of it.
 */
export function expectKnockback(
  game: Session,
  player: Player,
  aim: number,
  distance: number,
): void {
  const pending = game.knockbacks.get(player.id);
  const from = pending?.at ?? { x: player.tx, y: player.ty };
  const body = { ...from, vx: 0, vy: 0, radius: player.radius };
  const { knockbackSeconds } = game.config.player;
  game.knockbacks.set(player.id, {
    at: dashEnd(
      body,
      aim,
      distance,
      game.world.map,
      solidBodiesBut(game, player),
    ),
    until: game.time + knockbackSeconds + game.config.net.knockback.slack,
    pace: Math.max(pending?.pace ?? 0, paceOf(game, player)),
  });
}

/**
 * Settles, as the host, each push whose time is up: a player reported further from the push's
 * end than the tolerance plus its pace over the whole push and slack is put at the end. A client
 * that stops hosting forgets its pushes.
 */
export function checkKnockbacks(game: Session): void {
  if (!game.hosting) {
    game.knockbacks.clear();
    return;
  }
  const { slack, tolerance } = game.config.net.knockback;
  const window = game.config.player.knockbackSeconds + slack;
  for (const [id, expected] of game.knockbacks) {
    const player = game.players.get(id);
    if (player === undefined) {
      game.knockbacks.delete(id);
      continue;
    }
    const pace = Math.max(expected.pace, paceOf(game, player));
    if (game.time < expected.until) {
      game.knockbacks.set(id, { ...expected, pace });
      continue;
    }
    game.knockbacks.delete(id);
    const off = Math.hypot(
      player.tx - expected.at.x,
      player.ty - expected.at.y,
    );
    if (off > tolerance + pace * window)
      correctPlayer(game, player, expected.at);
  }
}
