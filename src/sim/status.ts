import { z } from "zod";
import { rounded } from "./rounded.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * What can be wrong with a world entity for a while:
 * - stunned: it can neither move nor see. Its kind's update and strikes are skipped while it
 *   lasts, so every kind honours it without asking, and it goes on from the state it had.
 */
const STATUSES = ["stunned"] as const;

/** A status a world entity can be under. */
type Status = (typeof STATUSES)[number];

/** When, on the world's clock, each status ends, sent to a hundredth of a second. */
const Ends = z.partialRecord(z.enum(STATUSES), rounded(2));

/**
 * The statuses each world entity is under, by its id: when each ends. The host keeps it, and
 * every client holds it, to draw them and so that a new host goes on from it.
 */
export const entityStatuses = worldData({
  schema: z.record(z.string(), Ends),
  initial: {},
});

/** Whether the world entity `id` is under `status` now. */
function isUnder(game: Session, id: string, status: Status): boolean {
  const ends = entityStatuses.get(game)[id]?.[status];
  return ends !== undefined && game.worldTime < ends;
}

/**
 * Puts the world entity `id` under `status` for `seconds` from now, or for longer if it already
 * is. Only the host does; on any other client it changes nothing. Returns whether it did.
 */
function inflict(
  game: Session,
  id: string,
  status: Status,
  seconds: number,
): boolean {
  if (!game.hosting || !game.entities.has(id)) return false;
  const held = entityStatuses.get(game);
  const ends = Math.max(held[id]?.[status] ?? 0, game.worldTime + seconds);
  return entityStatuses.set(game, {
    ...held,
    [id]: { ...held[id], [status]: ends },
  });
}

/** Whether the world entity `id` is stunned: it can neither move nor see. */
export function isStunned(game: Session, id: string): boolean {
  return isUnder(game, id, "stunned");
}

/**
 * Stuns the world entity `id` for `seconds`, or for longer if it already is; only the host does.
 * Returns whether it did.
 */
export function stun(game: Session, id: string, seconds: number): boolean {
  return inflict(game, id, "stunned", seconds);
}

/** As the host, forgets statuses that have ended, and those of entities gone from the world. */
export function pruneStatuses(game: Session): void {
  const held = entityStatuses.get(game);
  let changed = false;
  const kept: Record<string, Partial<Record<Status, number>>> = {};
  for (const [id, ends] of Object.entries(held)) {
    const lasting = Object.fromEntries(
      Object.entries(ends).filter(([, end]) => game.worldTime < end),
    );
    if (!game.entities.has(id) || Object.keys(lasting).length === 0) {
      changed = true;
      continue;
    }
    if (Object.keys(lasting).length !== Object.keys(ends).length)
      changed = true;
    kept[id] = lasting;
  }
  if (changed) entityStatuses.set(game, kept);
}
