import { isSweepFree } from "./collision.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import { keepsPace, notePace, restartStaminaChecks } from "./stamina-checks.js";

/** How the host holds each remote player to the moves its rules allow. */
export interface MoveCheckConfig {
  /** Pixels a report may stray past what the rules allow, for rounding and bodies pushed apart. */
  readonly slack: number;
  /**
   * Seconds of top speed a report may carry past the time since the last report taken, for
   * reports that arrive late or several at once.
   */
  readonly lateSeconds: number;
  /**
   * Seconds after a player joins, comes back to its page or falls silent and returns, or a new
   * host takes over, in which its reports are taken as they come.
   */
  readonly settleSeconds: number;
  /**
   * About a round trip, in seconds: how long after a correction reports sent before it may still
   * arrive, and how long past its own time a push or lunge may take to show in reports.
   */
  readonly roundTripSeconds: number;
}

/** A move a player may make on top of its own speed, until a time in sim seconds. */
interface Allowance {
  readonly distance: number;
  readonly until: number;
}

/** What the host knows of one remote player's moves. Times are in sim seconds. */
export interface MoveCheck {
  /** Where the player last stood in a report the host took, or where the host put it. */
  at: Point;
  /** When the host took that report, or put the player there. */
  time: number;
  /** Until when every report is taken as it comes. */
  settleUntil: number;
  /** Until when a report that breaks the rules is held at `at` rather than corrected again. */
  holdUntil: number;
  allowances: Allowance[];
}

/**
 * What the host does with a player's reported position:
 * - take: the player stands there
 * - hold: the player stays where it last stood, and is not corrected again
 * - correct: the player is put back `to`, where it last stood
 */
export type MoveVerdict =
  | { readonly kind: "take" }
  | { readonly kind: "hold" }
  | { readonly kind: "correct"; readonly to: Point };

/**
 * Whether a player's body fits along the straight way from `from` to `to`, or along either way
 * that turns one corner, as a player sliding along walls does between two reports.
 */
function hasPath(game: Session, from: Point, to: Point): boolean {
  const { map } = game.world;
  const half = game.config.player.radius;
  const sweep = (a: Point, b: Point): boolean => isSweepFree(map, half, a, b);
  const turns = [
    { x: to.x, y: from.y },
    { x: from.x, y: to.y },
  ];
  return (
    sweep(from, to) ||
    turns.some((corner) => sweep(from, corner) && sweep(corner, to))
  );
}

/** Pixels of pushes and lunges `check` allows on top of the player's own speed. */
function allowed(check: MoveCheck): number {
  let distance = 0;
  for (const allowance of check.allowances) distance += allowance.distance;
  return distance;
}

/**
 * Whether the player `playerId`, which stood as `check` says, can stand at `to` now, and has
 * the stamina for the pace it went at.
 */
function withinReach(
  game: Session,
  playerId: string,
  check: MoveCheck,
  to: Point,
): boolean {
  const { player, net } = game.config;
  const { slack, lateSeconds } = net.moves;
  const topSpeed =
    player.speed *
    Math.max(1, player.sprintMultiplier, player.crouchMultiplier);
  const extra = allowed(check);
  const reach =
    topSpeed * (game.time - check.time + lateSeconds) + slack + extra;
  return (
    Math.hypot(to.x - check.at.x, to.y - check.at.y) <= reach &&
    hasPath(game, check.at, to) &&
    keepsPace(game, playerId, to, extra)
  );
}

/**
 * Checks, as the host, a remote player's reported position against the last one taken: it must
 * lie within the player's top speed over the time since, plus any push or lunge allowed and the
 * configured slack, with no wall in the way, and keep to a walk while the host reckons the player
 * too spent to sprint. A player with no check yet starts one there.
 */
export function checkMove(
  game: Session,
  playerId: string,
  to: Point,
): MoveVerdict {
  const { time } = game;
  const check = game.moveChecks.get(playerId);
  if (check === undefined) {
    game.moveChecks.set(playerId, {
      at: { x: to.x, y: to.y },
      time,
      settleUntil: time + game.config.net.moves.settleSeconds,
      holdUntil: -Infinity,
      allowances: [],
    });
    notePace(game, playerId, to, 0);
    return { kind: "take" };
  }
  if (time < check.settleUntil || withinReach(game, playerId, check, to)) {
    notePace(game, playerId, to, allowed(check));
    check.at = { x: to.x, y: to.y };
    check.time = time;
    check.allowances = check.allowances.filter(
      (allowance) => allowance.until >= time,
    );
    return { kind: "take" };
  }
  if (time < check.holdUntil) return { kind: "hold" };
  return { kind: "correct", to: check.at };
}

/**
 * Lets the player `playerId` move `distance` pixels on top of its own speed in reports over the
 * next `seconds`, and a round trip after: a push it was dealt, or a lunge it made.
 */
export function allowMove(
  game: Session,
  playerId: string,
  distance: number,
  seconds: number,
): void {
  const check = game.moveChecks.get(playerId);
  if (check === undefined) return;
  const { roundTripSeconds } = game.config.net.moves;
  check.allowances.push({
    distance,
    until: game.time + seconds + roundTripSeconds,
  });
}

/**
 * Notes that the host put the player `playerId` at `at`: its reports are checked from there, and
 * for about a round trip one that breaks the rules, as one sent before the correction does, is
 * held there rather than corrected again.
 */
export function holdMoves(game: Session, playerId: string, at: Point): void {
  const { time } = game;
  const check = game.moveChecks.get(playerId);
  game.moveChecks.set(playerId, {
    at: { x: at.x, y: at.y },
    time,
    settleUntil: -Infinity,
    holdUntil: time + game.config.net.moves.roundTripSeconds,
    allowances: check?.allowances ?? [],
  });
}

/**
 * Starts the checks on `playerId` afresh, or on every player when none is given: the next report
 * is taken as it comes, and those for the settle time after it, and its stamina is reckoned full.
 */
export function restartMoveChecks(game: Session, playerId?: string): void {
  if (playerId === undefined) game.moveChecks.clear();
  else game.moveChecks.delete(playerId);
  restartStaminaChecks(game, playerId);
}
