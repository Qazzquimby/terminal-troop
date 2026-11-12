import type { Point } from "./map.js";
import { movement } from "./movement.js";
import type { Session } from "./session.js";
import {
  canSprint,
  createStamina,
  spendStamina,
  updateStamina,
} from "./stamina.js";
import type { Stamina, StaminaConfig } from "./stamina.js";

/** How the host reckons each remote player's stamina. */
export interface StaminaCheckConfig {
  /**
   * Stamina the host's reckoning holds over a full bar, so that reports arriving late or unevenly
   * never leave it reckoning a player emptier than the player's own bar.
   */
  readonly slack: number;
}

/** Where a player stood in a report the host took, and when, in sim seconds. */
interface Mark {
  readonly at: Point;
  readonly time: number;
}

/** What the host reckons of one remote player's stamina. Times are in sim seconds. */
export interface StaminaCheck {
  stamina: Stamina;
  /** Until when the player counts as sprinting whatever gait it reports. */
  fastUntil: number;
  /** When the player last reported sprinting. */
  sprintedAt: number;
  /** The reports taken over about the last round trip, oldest first. */
  trail: Mark[];
}

/** The rules the host reckons stamina by: a player's own, with the slack on top of a full bar. */
function reckoning(game: Session): StaminaConfig {
  const { stamina, net } = game.config;
  return { ...stamina, max: stamina.max + net.stamina.slack };
}

/** The host's reckoning of `playerId`'s stamina, full when it has none yet. */
function checkOn(game: Session, playerId: string): StaminaCheck {
  const known = game.staminaChecks.get(playerId);
  if (known !== undefined) return known;
  const check: StaminaCheck = {
    stamina: createStamina(reckoning(game)),
    fastUntil: -Infinity,
    sprintedAt: -Infinity,
    trail: [],
  };
  game.staminaChecks.set(playerId, check);
  return check;
}

/**
 * Steps, as the host, its reckoning of every remote player's stamina by the rules each player
 * keeps its own by: a player that reports sprinting while it moves, or was seen moving faster
 * than a walk, spends it; any other regains it after the wait.
 */
export function trackStamina(game: Session, dt: number): void {
  const rules = reckoning(game);
  for (const player of game.players.values()) {
    if (player === game.local) continue;
    const check = checkOn(game, player.id);
    const { mode, moving } = movement.get(player);
    const reported = mode === "sprint" && moving;
    if (reported) check.sprintedAt = game.time;
    const sprinting = reported || game.time < check.fastUntil;
    check.stamina = updateStamina(check.stamina, sprinting, dt, rules);
  }
}

/**
 * Notes, as the host, that it took `playerId`'s report of standing at `at` now. A walk can cover
 * only so much in the reports since about a round trip ago, plus `allowed` pixels of pushes and
 * lunges: a player that goes further without reporting a sprint counts as sprinting for as long
 * again, and spends stamina for it.
 */
export function notePace(
  game: Session,
  playerId: string,
  at: Point,
  allowed: number,
): void {
  const check = checkOn(game, playerId);
  const { time } = game;
  const { lateSeconds, roundTripSeconds } = game.config.net.moves;
  const from = check.trail[0];
  if (
    from !== undefined &&
    check.sprintedAt < from.time - lateSeconds &&
    !withinWalk(game, from, at, allowed)
  )
    check.fastUntil = Math.max(check.fastUntil, time + (time - from.time));
  const since = time - roundTripSeconds;
  check.trail = [
    ...check.trail.filter((mark) => mark.time >= since),
    { at: { x: at.x, y: at.y }, time },
  ];
}

/** Whether a walk from `from` reaches `to` by now, with `allowed` pixels of pushes and lunges. */
function withinWalk(
  game: Session,
  from: Mark,
  to: Point,
  allowed: number,
): boolean {
  const { player, net } = game.config;
  const { slack, lateSeconds } = net.moves;
  const walk = player.speed * Math.max(1, player.crouchMultiplier);
  const reach = walk * (game.time - from.time + lateSeconds) + slack + allowed;
  return Math.hypot(to.x - from.at.x, to.y - from.at.y) <= reach;
}

/**
 * Notes that `playerId` stands at `at` now, whatever came before, as when the host forces it there
 * or takes its reports as they come: its pace is reckoned from there.
 */
export function rebasePace(game: Session, playerId: string, at: Point): void {
  checkOn(game, playerId).trail = [
    { at: { x: at.x, y: at.y }, time: game.time },
  ];
}

/**
 * Whether, as the host, it takes `playerId`'s report of standing at `to` now as far as stamina
 * goes: a player the host reckons too spent to sprint must keep to a walk over the reports since
 * about a round trip ago, plus `allowed` pixels of pushes and lunges.
 */
export function keepsPace(
  game: Session,
  playerId: string,
  to: Point,
  allowed: number,
): boolean {
  const check = checkOn(game, playerId);
  const from = check.trail[0];
  return (
    canSprint(check.stamina) ||
    from === undefined ||
    withinWalk(game, from, to, allowed)
  );
}

/**
 * Spends, as the host, `amount` of `playerId`'s stamina as its client spends it on an action;
 * false, spending nothing, when the host reckons it has less. The local player's own stamina is
 * spent on its own client, so this is always true for it.
 */
export function hostSpends(
  game: Session,
  playerId: string,
  amount: number,
): boolean {
  if (playerId === game.localId) return true;
  const check = checkOn(game, playerId);
  const spent = spendStamina(check.stamina, amount);
  if (spent === null) return false;
  check.stamina = spent;
  return true;
}

/** Forgets the reckoning of `playerId`'s stamina, or of every player's, so it starts full. */
export function restartStaminaChecks(game: Session, playerId?: string): void {
  if (playerId === undefined) game.staminaChecks.clear();
  else game.staminaChecks.delete(playerId);
}
