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
  /**
   * Seconds by which the report that a player stopped sprinting, or its last kick, may arrive
   * later than a kick it sent after, so that the host starts reckoning its regeneration that much
   * late. A kick may borrow that much regeneration the host has not reckoned yet, which the
   * regeneration that follows pays back before the player may borrow again.
   */
  readonly lateSeconds: number;
}

/** What the host reckons of one remote player's stamina. Times are in sim seconds. */
export interface StaminaCheck {
  stamina: Stamina;
  /** Stamina the player spent on regeneration the host had not reckoned yet, still to pay back. */
  owed: number;
  /** Until when the player counts as sprinting whatever gait it reports. */
  fastUntil: number;
  /** When the player last reported sprinting. */
  sprintedAt: number;
  /** When the host last reckoned the player had the stamina to sprint. */
  sprintableAt: number;
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
    owed: 0,
    fastUntil: -Infinity,
    sprintedAt: -Infinity,
    sprintableAt: game.time,
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
    regain(check, sprinting, dt, rules);
    if (canSprint(check.stamina)) check.sprintableAt = game.time;
  }
}

/**
 * Steps `check`'s stamina by `rules`, its regeneration paying back what the player owes first.
 */
function regain(
  check: StaminaCheck,
  sprinting: boolean,
  dt: number,
  rules: StaminaConfig,
): void {
  const next = updateStamina(check.stamina, sprinting, dt, rules);
  const paid = Math.min(check.owed, next.value - check.stamina.value);
  if (paid <= 0) {
    check.stamina = next;
    return;
  }
  check.owed -= paid;
  const value = next.value - paid;
  check.stamina = {
    ...next,
    value,
    exhausted: check.stamina.exhausted && value < rules.recover,
  };
}

/**
 * Notes, as the host, that `playerId` went faster than a walk in the reports it took since
 * `since`: a player that did so without reporting a sprint counts as sprinting for a round trip,
 * and spends stamina for it.
 */
export function noteFast(game: Session, playerId: string, since: number): void {
  const check = checkOn(game, playerId);
  const { lateSeconds, roundTripSeconds } = game.config.net.moves;
  if (check.sprintedAt < since - lateSeconds)
    check.fastUntil = Math.max(check.fastUntil, game.time + roundTripSeconds);
}

/** Whether the host reckoned `playerId` had the stamina to sprint at any time since `time`. */
export function couldSprintSince(
  game: Session,
  playerId: string,
  time: number,
): boolean {
  const check = checkOn(game, playerId);
  return canSprint(check.stamina) || check.sprintableAt >= time;
}

/**
 * Spends, as the host, `amount` of `playerId`'s stamina as its client spends it on an action;
 * false, spending nothing, when the host reckons it has less, even borrowing what regeneration
 * the report of its rest may be late with and it does not owe already. The local player's own
 * stamina is spent on its own client, so this is always true for it.
 */
export function hostSpends(
  game: Session,
  playerId: string,
  amount: number,
): boolean {
  if (playerId === game.localId) return true;
  const check = checkOn(game, playerId);
  const spent = spendStamina(check.stamina, amount);
  if (spent !== null) {
    check.stamina = spent;
    return true;
  }
  const { stamina, net } = game.config;
  const short = amount - check.stamina.value;
  if (check.owed + short > stamina.regen * net.stamina.lateSeconds)
    return false;
  check.owed += short;
  check.stamina = { ...check.stamina, value: 0, rested: 0 };
  return true;
}

/** Forgets the reckoning of `playerId`'s stamina, or of every player's, so it starts full. */
export function restartStaminaChecks(game: Session, playerId?: string): void {
  if (playerId === undefined) game.staminaChecks.clear();
  else game.staminaChecks.delete(playerId);
}
