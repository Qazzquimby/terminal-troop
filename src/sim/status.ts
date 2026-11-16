import { z } from "zod";
import { isGone, livingBody } from "./bodies.js";
import { rounded } from "./rounded.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * What can be wrong with a body, a player or a world entity alike, for a while:
 * - stunned: it can neither move nor see. A world entity's kind update and strikes are skipped
 *   while it lasts, so every kind honours it without asking, and it goes on from the state it
 *   had. A player's steering is taken as standing still and its actions are refused, on the host
 *   and in its own client's prediction alike, and its view goes dark.
 * - shrouded: it takes the whole world for dark. Whatever it asks of light, as `isLitTo` answers,
 *   finds none, so a kind that shuns light neither steers round it nor wakes to it.
 */
const STATUSES = ["stunned", "shrouded"] as const;

/** A status a body can be under. */
type Status = (typeof STATUSES)[number];

/** How being stunned feels to the player it befalls: its view, and the ringing in its ears. */
export interface StunnedConfig {
  /** How dark the stunned player's view goes, 0..1: 1 is black. */
  readonly darkness: number;
  /** Seconds before the stun ends that its view starts to come back, clearing over them. */
  readonly fadeOut: number;
  /** The ringing in its ears while the stun lasts: how loud, 0..1, and how long it fades out. */
  readonly ring: { readonly volume: number; readonly fadeSeconds: number };
}

/** When, on the world's clock, each status ends, sent to a hundredth of a second. */
const Ends = z.partialRecord(z.enum(STATUSES), rounded(2));

/**
 * The statuses each body is under, by its id: when each ends. The host keeps it, and every
 * client holds it, to draw them, to predict its own player under them, and so that a new host
 * goes on from it.
 */
export const bodyStatuses = worldData({
  schema: z.record(z.string(), Ends),
  initial: {},
});

/** When, on the world's clock, the body `id`'s `status` ends; null when it is not under it. */
function endOf(game: Session, id: string, status: Status): number | null {
  const ends = bodyStatuses.get(game)[id]?.[status];
  return ends !== undefined && game.worldTime < ends ? ends : null;
}

/**
 * Puts the body `id` under `status` for `seconds` from now, or for longer if it already is. Only
 * the host does, and only to a body in the world that is not dead or a ghost; on any other client
 * it changes nothing. Returns whether it did.
 */
function inflict(
  game: Session,
  id: string,
  status: Status,
  seconds: number,
): boolean {
  if (!game.hosting || livingBody(game, id) === null) return false;
  const held = bodyStatuses.get(game);
  const ends = Math.max(held[id]?.[status] ?? 0, game.worldTime + seconds);
  return bodyStatuses.set(game, {
    ...held,
    [id]: { ...held[id], [status]: ends },
  });
}

/** Whether the body `id`, a player or a world entity, is stunned: it can neither move nor see. */
export function isStunned(game: Session, id: string): boolean {
  return endOf(game, id, "stunned") !== null;
}

/** Seconds left of the stun on the body `id`; null when it is not stunned. */
export function stunLeft(game: Session, id: string): number | null {
  const ends = endOf(game, id, "stunned");
  return ends === null ? null : ends - game.worldTime;
}

/** The ids of every body under a stun now, players and world entities alike. */
export function stunnedIds(game: Session): string[] {
  const now = game.worldTime;
  return Object.entries(bodyStatuses.get(game))
    .filter(([, ends]) => ends.stunned !== undefined && now < ends.stunned)
    .map(([id]) => id);
}

/**
 * Stuns the body `id`, a player or a world entity, for `seconds`, or for longer if it already is;
 * only the host does. Returns whether it did.
 */
export function stun(game: Session, id: string, seconds: number): boolean {
  return inflict(game, id, "stunned", seconds);
}

/** Whether the body `id`, a player or a world entity, is shrouded: it takes the world for dark. */
export function isShrouded(game: Session, id: string): boolean {
  return endOf(game, id, "shrouded") !== null;
}

/** Seconds left of the shroud on the body `id`; null when it is not shrouded. */
export function shroudLeft(game: Session, id: string): number | null {
  const ends = endOf(game, id, "shrouded");
  return ends === null ? null : ends - game.worldTime;
}

/**
 * Shrouds the body `id`, a player or a world entity, for `seconds`, or for longer if it already
 * is; only the host does. Returns whether it did.
 */
export function shroud(game: Session, id: string, seconds: number): boolean {
  return inflict(game, id, "shrouded", seconds);
}

/**
 * As the host, forgets statuses that have ended, and those of bodies gone from the world, dead
 * or turned ghost.
 */
export function pruneStatuses(game: Session): void {
  const held = bodyStatuses.get(game);
  let changed = false;
  const kept: Record<string, Partial<Record<Status, number>>> = {};
  for (const [id, ends] of Object.entries(held)) {
    const lasting = Object.fromEntries(
      Object.entries(ends).filter(([, end]) => game.worldTime < end),
    );
    if (isGone(game, id) || Object.keys(lasting).length === 0) {
      changed = true;
      continue;
    }
    if (Object.keys(lasting).length !== Object.keys(ends).length)
      changed = true;
    kept[id] = lasting;
  }
  if (changed) bodyStatuses.set(game, kept);
}

/** The id the ringing in a stunned player's ears loops under. */
const RING_ID = "status/stunned-ring";

/** The ringing a stunned player hears, looped while the stun lasts. */
const ringUrl = new URL("./sfx/stunned-ring.mp3", import.meta.url).href;

/** Whether each session's local player was stunned as of its last step. */
const ringing = new WeakMap<Session, boolean>();

/**
 * On every client, rings in the local player's ears while it is stunned, fading out as the stun
 * ends: a sound for it alone, not heard in the world.
 */
export function hearStatuses(game: Session): void {
  const stunned = isStunned(game, game.local.id);
  if (stunned === (ringing.get(game) ?? false)) return;
  ringing.set(game, stunned);
  const { ring } = game.config.stunned;
  if (stunned)
    void game.sfx.playLoop(RING_ID, ringUrl, null, null, {
      volume: ring.volume,
    });
  else game.sfx.stop(RING_ID, ring.fadeSeconds);
}
