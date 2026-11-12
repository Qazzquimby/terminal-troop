import { z } from "zod";
import { canStandAt } from "./arrival.js";
import { nearestFreePoint } from "./collision.js";
import { contentEvent } from "./content-event.js";
import { snapPrevious } from "./interpolation.js";
import type { Point } from "./map.js";
import { rebaseMoves } from "./move-checks.js";
import type { Player, PlayerState } from "./player.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/** A slide's length, in sim seconds. */
const Slide = z.object({ seconds: z.number().positive() });
type Slide = z.infer<typeof Slide>;

/**
 * A move the host forces on one player: its epoch, which counts the host's forced moves on that
 * player from 1; where it puts the player; and, for a slide rather than a jump, how long the
 * player takes to slide there.
 */
const ForcedMove = z.object({
  epoch: z.number().int().positive(),
  to: z.object({ x: z.number(), y: z.number() }),
  slide: Slide.optional(),
});
export type ForcedMove = z.infer<typeof ForcedMove>;

/**
 * The latest move the host forced on each player, by player id. It travels with the world
 * state, so a client that missed the move's event, joins later or takes over as host has it.
 */
export const forcedMoves = worldData({
  schema: z.record(z.string(), ForcedMove),
  initial: {},
});

/**
 * The latest forced move this client knows of on player `id`, 0 before any: for the local
 * player, the latest it has taken; for any other, the latest the host has made on it.
 */
export function expectedEpoch(game: Session, id: string): number {
  if (id === game.localId) return game.local.epoch;
  return Math.max(
    game.forcedSeen.get(id)?.epoch ?? 0,
    forcedMoves.get(game)[id]?.epoch ?? 0,
  );
}

/**
 * Whether the position `state` reports is held back: true unless the STATE has taken exactly
 * the forced moves this client knows of on its player. A STATE sent before the player took the
 * latest forced move, or one whose epoch the host never issued, moves nobody.
 */
export function positionHeld(game: Session, state: PlayerState): boolean {
  return state.epoch !== expectedEpoch(game, state.id);
}

/** Puts `player` at `at` at once: at rest, any dash dropped, and drawn there rather than sliding. */
function placeAt(player: Player, at: Point): void {
  player.x = player.tx = at.x;
  player.y = player.ty = at.y;
  player.vx = 0;
  player.vy = 0;
  player.dash = null;
  snapPrevious(player);
}

/** Moves `player` as `move` says: a straight slide over its time, or a jump. */
function moveAs(player: Player, { to, slide }: ForcedMove): void {
  const dx = to.x - player.x;
  const dy = to.y - player.y;
  if (slide === undefined || (dx === 0 && dy === 0)) {
    placeAt(player, to);
    return;
  }
  const { seconds } = slide;
  player.dash = { vx: dx / seconds, vy: dy / seconds, seconds, to };
  player.tx = to.x;
  player.ty = to.y;
}

/**
 * Takes the forced move `move` on player `target`, once. The local player moves and reports at
 * once. Any other player's copy goes there too, unless it already stands where a STATE that
 * took the move put it.
 */
function takeForcedMove(game: Session, target: string, move: ForcedMove): void {
  if (target === game.localId) {
    const { local } = game;
    if (move.epoch <= local.epoch || game.ignoresForcedMoves) return;
    local.epoch = move.epoch;
    game.epochSettled = true;
    moveAs(local, move);
    game.reportNow = true;
    return;
  }
  if (move.epoch <= (game.forcedSeen.get(target)?.epoch ?? 0)) return;
  game.forcedSeen.set(target, move);
  const copy = game.players.get(target);
  if (copy !== undefined && copy.epoch < move.epoch) moveAs(copy, move);
}

/** A move the host forces on one player, for every client to take. */
const forced = contentEvent({
  schema: ForcedMove.extend({ target: z.string() }),
  to: "all",
  from: "host",
  receive(game, { target, ...move }) {
    takeForcedMove(game, target, move);
  },
});

/** The events forced moves travel as, by key. */
export const forcedMoveEvents = { forced };

/**
 * Takes the forced moves the world state holds that this client has not. The local player's
 * epoch first settles on what the world state holds for it, without moving: a player that
 * joins, or joins again, starts from the room's count, and moves only on forced moves after it.
 */
export function followForcedMoves(game: Session): void {
  const moves = forcedMoves.get(game);
  if (
    !game.epochSettled &&
    (game.hosting || game.worldValues.has(forcedMoves))
  ) {
    game.local.epoch = Math.max(
      game.local.epoch,
      moves[game.localId]?.epoch ?? 0,
    );
    game.epochSettled = true;
  }
  for (const [id, move] of Object.entries(moves))
    if (id !== game.localId || game.epochSettled)
      takeForcedMove(game, id, move);
}

/**
 * As a client that has just taken over hosting, counts on from the highest epoch it has heard
 * of for each player: from the world state, the forced moves it heard, and each player's STATE.
 * What it heard beyond the world state goes into the world state.
 */
export function takeOverForcedMoves(game: Session): void {
  const moves = { ...forcedMoves.get(game) };
  const heard = new Map(game.forcedSeen);
  for (const player of game.players.values())
    if (
      player !== game.local &&
      player.heardEpoch > expectedEpoch(game, player.id)
    )
      heard.set(player.id, {
        epoch: player.heardEpoch,
        to: { x: player.tx, y: player.ty },
      });
  const newer = [...heard].filter(
    ([id, move]) => move.epoch > (moves[id]?.epoch ?? 0),
  );
  if (newer.length === 0) return;
  for (const [id, move] of newer) {
    moves[id] = move;
    game.forcedSeen.set(id, move);
  }
  forcedMoves.set(game, moves);
}

/**
 * As the host, moves `player` to `to` under a new epoch, as a slide over `slide.seconds` or at
 * once, on every client: the local player here at once, and every other client's copy of the
 * player as the move reaches it. The player's own client reports the new epoch once it takes
 * the move, and until it does every client holds its reported position back, so its copies stay
 * where the host put it. Does nothing on a client not hosting, or for a player not in the session.
 */
export function forcePlayer(
  game: Session,
  player: Player,
  to: Point,
  slide?: Slide,
): void {
  if (!game.hosting || game.players.get(player.id) !== player) return;
  const epoch = Math.max(expectedEpoch(game, player.id), player.heardEpoch) + 1;
  const move: ForcedMove = {
    epoch,
    to: { x: to.x, y: to.y },
    ...(slide !== undefined && { slide }),
  };
  takeForcedMove(game, player.id, move);
  if (player !== game.local) rebaseMoves(game, player.id, move.to);
  forcedMoves.set(game, { ...forcedMoves.get(game), [player.id]: move });
  forced.send(game, { target: player.id, ...move });
}

/**
 * As the host, moves `player` to `at` at once, or to the nearest point a player can stand when
 * `at` is blocked. An `at` that is not a finite point is ignored.
 */
export function correctPlayer(game: Session, player: Player, at: Point): void {
  if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
  const { radius } = game.config.player;
  const to = canStandAt(game.world, at, radius)
    ? at
    : nearestFreePoint(game.world.map, radius, at);
  forcePlayer(game, player, to);
}
