import { z } from "zod";
import { asPlayer, bodyById, engages, isPlayer } from "./bodies.js";
import type { Body } from "./bodies.js";
import { applyDamage } from "./entity.js";
import { noteFall } from "./fallen.js";
import { isGhost } from "./ghosts.js";
import { hurtPlayer } from "./health.js";
import { rounded } from "./rounded.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * The last time a body was hurt, and by whom:
 * - by: the id of the body that dealt it, any body, the victim itself included; null for no one,
 *   such as the world itself
 * - at: when, on the world's clock, sent to a hundredth of a second
 * - fresh: set on a world entity hurt since its kind last ran; see `hurtSinceLastStep`
 */
const Hurt = z.object({
  by: z.string().min(1).max(64).nullable(),
  at: rounded(2),
  fresh: z.literal(true).optional(),
});

/** Who last hurt a body, and when. */
export interface HurtRecord {
  readonly by: string | null;
  readonly at: number;
}

/**
 * The last hurt of each body, players and world entities alike, by the victim's id. The host
 * keeps it, and every client holds it, so that a new host goes on from it.
 */
export const lastHurts = worldData({
  schema: z.record(z.string(), Hurt),
  initial: {},
});

/**
 * The world entities, by id, that may have been hurt since their kind last ran, as this host
 * tracks them through a step, so that settling each one as it runs reads the record only if so.
 */
const unsettled = new WeakMap<Session, Set<string>>();

/** Notes on the host's record that `victim` was hurt just now by `by`. */
function record(game: Session, victim: Body, by: string | null): void {
  const fresh = !isPlayer(game, victim);
  if (fresh) unsettled.get(game)?.add(victim.id);
  lastHurts.set(game, {
    ...lastHurts.get(game),
    [victim.id]: { by, at: game.worldTime, ...(fresh && { fresh: true }) },
  });
}

/**
 * Deals `amount` damage to `body` for real, as the host, and notes that `by`, a body's id or null
 * for no one, dealt it. A player's health comes off the host's record; a world entity's off the
 * entity. Does nothing on a client not hosting, to a body not in the world, to a ghost, for no
 * damage, or between two world entities that do not engage, away from every player (`engages`). Content hurts through `hurt` in the actions framework, which calls this on the host.
 */
export function dealDamage(
  game: Session,
  body: Body,
  amount: number,
  by: string | null,
): void {
  if (!game.hosting || !(amount > 0) || bodyById(game, body.id) !== body)
    return;
  if (!engages(game, by, body)) return;
  const player = asPlayer(game, body);
  if (player !== null) {
    if (isGhost(player)) return;
    hurtPlayer(game, player, amount);
  } else {
    if (body.health <= 0) return;
    applyDamage(body, amount);
  }
  record(game, body, by);
  if (body.health <= 0) noteFall(game, body, by);
}

/** Who last hurt the body `id`, and when; null when nothing on record has. */
export function lastHurt(game: Session, id: string): HurtRecord | null {
  const held = lastHurts.get(game)[id];
  return held === undefined ? null : { by: held.by, at: held.at };
}

/**
 * The id of the body that last hurt the body `id`, if that was within `withinSeconds`, or at any
 * time when left out; null when none did, or it was no one's doing.
 */
export function lastHurtBy(
  game: Session,
  id: string,
  withinSeconds = Infinity,
): string | null {
  const last = lastHurt(game, id);
  if (last === null || game.worldTime - last.at > withinSeconds) return null;
  return last.by;
}

/**
 * Whether the world entity `id` was hurt since its kind last ran, and if so, by whom and when:
 * for a kind's update to react to being hurt, once. A stunned entity's kind does not run, so it
 * reacts to a hurt taken while stunned once the stun ends. Null when it was not.
 */
export function hurtSinceLastStep(
  game: Session,
  id: string,
): HurtRecord | null {
  const held = lastHurts.get(game)[id];
  return held?.fresh === true ? { by: held.by, at: held.at } : null;
}

/** As the host, notes that the world entity `id`'s kind has just run, and so seen its hurts. */
export function settleHurts(game: Session, id: string): void {
  if (unsettled.get(game)?.delete(id) !== true) return;
  const held = lastHurts.get(game);
  const own = held[id];
  if (own?.fresh !== true) return;
  lastHurts.set(game, { ...held, [id]: { by: own.by, at: own.at } });
}

/**
 * As the host, at the start of a step of the world entities: forgets the hurts of bodies gone
 * from the world, ghosts kept, and notes those whose kinds have yet to see them.
 */
export function pruneHurts(game: Session): void {
  const held = lastHurts.get(game);
  unsettled.set(
    game,
    new Set(Object.keys(held).filter((id) => held[id]?.fresh === true)),
  );
  const kept = Object.entries(held).filter(
    ([id]) => bodyById(game, id) !== null,
  );
  if (kept.length < Object.keys(held).length)
    lastHurts.set(game, Object.fromEntries(kept));
}
