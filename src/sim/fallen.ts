import { z } from "zod";
import { asEntity, asPlayer, bodyById } from "./bodies.js";
import type { Body } from "./bodies.js";
import type { WorldEntity } from "./entities.js";
import { PLAYER_TAG } from "./noise.js";
import { rounded } from "./rounded.js";
import type { Session } from "./session.js";
import { worldData } from "./world-data.js";

/**
 * A body as a log names it:
 * - id: the body's id
 * - kind: what it is: its kind's name, or "player"; "unknown" for a body not in the world
 * - label: which one: `<kind>#<id>` for a world entity, `player <name>` for a player
 */
const Who = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().max(64),
  label: z.string().max(96),
});
export type Who = z.infer<typeof Who>;

/** The world entity `entity` as a log names it. */
export function entityWho(game: Session, entity: WorldEntity): Who {
  const { id } = entity;
  let kind = "unknown";
  for (const [name, number] of game.kindIds)
    if (number === entity.kind) kind = name;
  return { id, kind, label: `${kind}#${id}` };
}

/** The body `id`, as `bodyById` finds it, as a log names it now. */
export function who(game: Session, id: string): Who {
  const body = bodyById(game, id);
  if (body === null) return { id, kind: "unknown", label: `?#${id}` };
  const player = asPlayer(game, body);
  if (player !== null)
    return { id, kind: PLAYER_TAG, label: `${PLAYER_TAG} ${player.name}` };
  const entity = asEntity(game, body);
  return entity === null
    ? { id, kind: "unknown", label: `?#${id}` }
    : entityWho(game, entity);
}

/**
 * One body's health running out:
 * - n: counts the falls since the world began, so a client tells the new from those it has seen
 * - victim: what fell, named as it was then
 * - by: what dealt the last of it, named as it was then; null for no one, such as the world
 * - at: when, on the world's clock
 */
const Fall = z.object({
  n: z.number().int().min(0),
  victim: Who,
  by: Who.nullable(),
  at: rounded(2),
});
export type Fall = z.infer<typeof Fall>;

/** How many of the latest falls the record keeps; older ones are dropped. */
const FALLS_KEPT = 8;

/**
 * The latest falls of any body, players and world entities alike, oldest first. The host keeps
 * it and every client holds it, so each can tell what fell to what even when the body is gone
 * before a snapshot shows it at no health. Names are taken as the body falls, as its killer may
 * be gone by the time a client reads it.
 */
export const falls = worldData({
  schema: z.array(Fall).max(FALLS_KEPT),
  initial: [],
});

/** As the host, notes that `victim`'s health has just run out, the last of it dealt by `by`. */
export function noteFall(game: Session, victim: Body, by: string | null): void {
  const held = falls.get(game);
  const entity = asEntity(game, victim);
  const fall: Fall = {
    n: (held.at(-1)?.n ?? -1) + 1,
    victim: entity === null ? who(game, victim.id) : entityWho(game, entity),
    by: by === null ? null : who(game, by),
    at: game.worldTime,
  };
  falls.set(game, [...held, fall].slice(-FALLS_KEPT));
}

/**
 * One fallen body brought back to life:
 * - n: counts the risings since the world began, so a client tells the new from those it has seen
 * - body: what rose, named as it was then
 * - by: what brought it back, named as it was then; null for no one
 * - at: when, on the world's clock
 */
const Rise = z.object({
  n: z.number().int().min(0),
  body: Who,
  by: Who.nullable(),
  at: rounded(2),
});
export type Rise = z.infer<typeof Rise>;

/**
 * The latest bodies brought back to life, oldest first, kept as the falls are, so every client
 * can tell what brought each back.
 */
export const rises = worldData({
  schema: z.array(Rise).max(FALLS_KEPT),
  initial: [],
});

/** As the host, notes that `body` has just been brought back to life by `by`. */
export function noteRise(game: Session, body: Body, by: string | null): void {
  const held = rises.get(game);
  const rise: Rise = {
    n: (held.at(-1)?.n ?? -1) + 1,
    body: who(game, body.id),
    by: by === null ? null : who(game, by),
    at: game.worldTime,
  };
  rises.set(game, [...held, rise].slice(-FALLS_KEPT));
}
