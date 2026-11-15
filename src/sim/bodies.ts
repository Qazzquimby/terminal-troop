import type { WorldEntity } from "./entities.js";
import { isAboard, playersOutside } from "./aboard.js";
import { isGhost } from "./ghosts.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import type { Footprint } from "./shape.js";

/*
 * A body is anything in the world that stands somewhere, has health and can be hurt: a player or a
 * world entity. Sim rules that could touch either, such as damage and who dealt it, go over bodies
 * rather than special-casing players. The two still live in separate stores, `game.players` and
 * `game.entities`, as networking and prediction run them differently.
 */

/** A player or a world entity. */
export type Body = Player | WorldEntity;

/** The player or world entity `id`, ghosts and the dead included; null for neither. */
export function bodyById(
  game: Session,
  id: string | null | undefined,
): Body | null {
  if (id === null || id === undefined) return null;
  return game.players.get(id) ?? game.entities.get(id) ?? null;
}

/** `body` as one of the session's players; null for a world entity, or a body not in the session. */
export function asPlayer(game: Session, body: Body): Player | null {
  const player = game.players.get(body.id);
  return player === body ? player : null;
}

/** `body` as one of the session's world entities; null for a player, or a body not in the session. */
export function asEntity(game: Session, body: Body): WorldEntity | null {
  const entity = game.entities.get(body.id);
  return entity === body ? entity : null;
}

/** Whether `body` is one of the session's players, rather than a world entity. */
export const isPlayer = (game: Session, body: Body): boolean =>
  asPlayer(game, body) !== null;

/**
 * Every body out in the world that is not dead: each living player, then each world entity with
 * health left, items lying about included. Ghosts are left out, and so is every body inside a
 * vehicle: nothing out in the world sees, strikes or targets it.
 */
export function livingBodies(game: Session): Body[] {
  return [
    ...playersOutside(game),
    ...[...game.entities.values()].filter(
      (entity) => entity.health > 0 && !isAboard(entity),
    ),
  ];
}

/** Whether the body `id` is gone from the world, dead, or a ghost. */
export function isGone(game: Session, id: string): boolean {
  const body = bodyById(game, id);
  if (body === null) return true;
  const player = asPlayer(game, body);
  return player === null ? body.health <= 0 : isGhost(player);
}

/**
 * The body `id` while it is out in the world and not dead or a ghost; null otherwise, inside a
 * vehicle too, so a monster after it loses it there.
 */
export function livingBody(
  game: Session,
  id: string | null | undefined,
): Body | null {
  const body = bodyById(game, id);
  return body === null || isGone(game, body.id) || isAboard(body) ? null : body;
}

/**
 * Where `body` is and what it fills: its kind's box, turned the way it points, or else the disc
 * of its radius, as every player's is.
 */
export function footprintOf(game: Session, body: Body): Footprint {
  const entity = asEntity(game, body);
  const box =
    entity === null
      ? null
      : (game.entityTypes.get(entity.kind)?.box(entity) ?? null);
  return { x: body.x, y: body.y, radius: body.radius, box };
}
