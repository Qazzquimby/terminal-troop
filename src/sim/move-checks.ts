import { isSweepFree } from "./collision.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import {
  couldSprintSince,
  noteFast,
  restartStaminaChecks,
} from "./stamina-checks.js";

/** How the host holds each remote player to the moves its rules allow. */
export interface MoveCheckConfig {
  /** Pixels a report may stray past what the rules allow, for rounding and bodies pushed apart. */
  readonly slack: number;
  /**
   * Seconds of top speed a report may carry past the time since an earlier report taken, for
   * reports that arrive late or several at once.
   */
  readonly lateSeconds: number;
  /**
   * Seconds over which the host holds a player to its top speed: long enough that the lateness
   * and slack are small beside it, so that a player kept even a little too fast falls behind.
   */
  readonly windowSeconds: number;
  /**
   * Seconds after a player joins, comes back to its page or falls silent and returns, or a new
   * host takes over, in which its reports are taken as they come.
   */
  readonly settleSeconds: number;
  /** About a round trip, in seconds: how long past its own time a lunge may take to show in reports. */
  readonly roundTripSeconds: number;
}

/** A move a player may make on top of its own speed, until a time in sim seconds. */
interface Allowance {
  readonly distance: number;
  readonly until: number;
}

/**
 * Where a player stood in the last report the host took at one time, in sim seconds, or where the
 * host put it, and how far it had gone by then in the reports taken since its check started.
 */
interface Mark {
  readonly at: Point;
  readonly time: number;
  readonly travelled: number;
}

/** What the host knows of one remote player's moves. Times are in sim seconds. */
export interface MoveCheck {
  /**
   * Where the player stood over the last window, oldest first, one for each time reports were
   * taken: the first is the newest at least a window old, where there is one, and the last is the
   * latest. Never empty. Reports taken at one time may have been sent well apart and held up on
   * the way, so only the last of them, sent most recently, marks when the player stood there.
   */
  marks: Mark[];
  /** Until when every report is taken as it comes. */
  settleUntil: number;
  allowances: Allowance[];
}

/**
 * What the host does with a player's reported position:
 * - take: the player stands there
 * - correct: the player is put back `to`, where it last stood
 */
export type MoveVerdict =
  { readonly kind: "take" } | { readonly kind: "correct"; readonly to: Point };

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

/** Pixels of pushes and lunges `check` allows on top of the player's own speed since `time`. */
function allowedSince(check: MoveCheck, time: number): number {
  let distance = 0;
  for (const allowance of check.allowances)
    if (allowance.until >= time) distance += allowance.distance;
  return distance;
}

/** A mark of standing at `at` now, `travelled` pixels along. */
function markOf(game: Session, at: Point, travelled: number): Mark {
  return { at: { x: at.x, y: at.y }, time: game.time, travelled };
}

/**
 * Whether going `distance` pixels since `time` is within `speed`, with `allowed` pixels of pushes
 * and lunges, the lateness and the slack on top.
 */
function withinPace(
  game: Session,
  time: number,
  distance: number,
  speed: number,
  allowed: number,
): boolean {
  const { slack, lateSeconds } = game.config.net.moves;
  return distance <= speed * (game.time - time + lateSeconds) + slack + allowed;
}

/**
 * The fastest the player `playerId` may have gone since `time`: a sprint if the host reckoned it
 * had the stamina for one at any time since, a walk otherwise.
 */
function topSpeed(game: Session, playerId: string, time: number): number {
  const { speed, sprintMultiplier, crouchMultiplier } = game.config.player;
  const sprint = couldSprintSince(game, playerId, time) ? sprintMultiplier : 1;
  return speed * Math.max(1, sprint, crouchMultiplier);
}

/** Notes in `check` that the player stood at `to`, forgetting what fell out of the window. */
function remember(game: Session, check: MoveCheck, to: Mark): void {
  const since = game.time - game.config.net.moves.windowSeconds;
  const kept = check.marks.filter((mark) => mark.time < to.time);
  const marks = [...kept, to];
  let first = 0;
  while ((marks[first + 1]?.time ?? Infinity) <= since) first++;
  check.marks = marks.slice(first);
  const oldest = check.marks[0]?.time ?? to.time;
  check.allowances = check.allowances.filter(
    (allowance) => allowance.until >= oldest,
  );
}

/**
 * Checks, as the host, a remote player's reported position: the way from the last one taken must
 * be clear of walls, and from each taken over the last window the player must have gone, along
 * the reports taken since, within its top speed over the time since, plus any push or lunge
 * allowed then, the lateness and the slack. Its top speed is a sprint while the host reckons it
 * has the stamina, a walk otherwise. A player with no check yet starts one there.
 */
export function checkMove(
  game: Session,
  playerId: string,
  to: Point,
): MoveVerdict {
  const check = game.moveChecks.get(playerId);
  if (check === undefined) {
    game.moveChecks.set(playerId, {
      marks: [markOf(game, to, 0)],
      settleUntil: game.time + game.config.net.moves.settleSeconds,
      allowances: [],
    });
    return { kind: "take" };
  }
  if (game.time < check.settleUntil) {
    check.marks = [markOf(game, to, 0)];
    return { kind: "take" };
  }
  const last = check.marks[check.marks.length - 1];
  if (last === undefined) throw new Error("a move check with no marks");
  const now = markOf(
    game,
    to,
    last.travelled + Math.hypot(to.x - last.at.x, to.y - last.at.y),
  );
  const { speed, crouchMultiplier } = game.config.player;
  const walk = speed * Math.max(1, crouchMultiplier);
  let fastSince = -Infinity;
  for (const from of check.marks) {
    const distance = now.travelled - from.travelled;
    const allowed = allowedSince(check, from.time);
    const top = topSpeed(game, playerId, from.time);
    if (!withinPace(game, from.time, distance, top, allowed))
      return { kind: "correct", to: last.at };
    if (!withinPace(game, from.time, distance, walk, allowed))
      fastSince = from.time;
  }
  if (!hasPath(game, last.at, to)) return { kind: "correct", to: last.at };
  if (fastSince > -Infinity) noteFast(game, playerId, fastSince);
  remember(game, check, now);
  return { kind: "take" };
}

/**
 * Lets the player `playerId` move `distance` pixels on top of its own speed in reports over the
 * next `seconds`, and a round trip after: a lunge it made.
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
 * Notes that the host forced the player `playerId` to `at`: its reports that took the move are
 * checked from there. Reports sent before it never reach the checks, so need no allowance.
 */
export function rebaseMoves(game: Session, playerId: string, at: Point): void {
  const check = game.moveChecks.get(playerId);
  game.moveChecks.set(playerId, {
    marks: [markOf(game, at, 0)],
    settleUntil: -Infinity,
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
