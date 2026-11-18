import type { WorldEntity } from "./entities.js";
import { isShutIn, playersExposed } from "./aboard.js";
import { isGhost, livingPlayers } from "./ghosts.js";
import { isDeepdark } from "./light.js";
import type { Point } from "./map.js";
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

/*
 * Most bodies are there for every body to perceive. A kind can name the one body that perceives
 * one of it instead (`perceivedBy`), as a haunting only its victim sees: to every other body it is
 * not there at all. Nothing sees, hears, hunts, strikes, traps or bumps into it, and no other
 * player's client draws it, plays its sounds or logs it. A kind can also be perceived only while
 * one of it lies in deepdark (`onlyInDeepdark`), as dark scrap: out of it, it is not there to
 * anybody. `perceives` is the one rule they all ask.
 */

/**
 * Whether the body `by`, by id, perceives the body `id`: always, unless `id` is of a kind that
 * names the one body perceiving it, which must then be `by`, or of a kind perceived only in
 * deepdark lying out of it. Null for `by` is no body at all, as a dead player's free camera,
 * which perceives only what every body does.
 */
export function perceives(
  game: Session,
  by: string | null,
  id: string | null | undefined,
): boolean {
  if (id === null || id === undefined) return true;
  const entity = game.entities.get(id);
  if (entity === undefined) return true;
  const type = game.entityTypes.get(entity.kind);
  if (type === undefined) return true;
  if (type.onlyInDeepdark(entity, game) && !isDeepdark(game, entity))
    return false;
  if (!type.restricted) return true;
  return by !== null && type.perceiver(entity) === by;
}

/*
 * World entities only act on one another where a player could see it happen (#360): two world
 * entities engage, one hunting, striking, hurting, trapping, setting off or catching the other,
 * only while both are in play, within the engagement range of some living player. Farther off
 * they still move and go about their business but pass each other by, so the world does not thin
 * itself out off-screen. A player is always in play, so nothing a world entity does to a player,
 * or a player to it, is held back. What picks the bodies a world entity acts on goes through
 * `livingBodies` with that entity as `by`, and `dealDamage` holds back any hurt between two world
 * entities that do not engage, whatever picked it.
 */

/** How near world entities must be to a player to act on one another. */
export interface EngagementConfig {
  /**
   * How near a living player, in pixels, a world entity must be to be in play. Infinity puts
   * every world entity in play wherever it is, players or none.
   */
  readonly range: number;
}

/**
 * Whether a world entity at a point is in play: within the engagement range of a living player,
 * not a ghost, but one in a vehicle too. The players are taken once, as they stand now, for a
 * rule that asks of many points.
 */
function inPlayNow(game: Session): (at: Point) => boolean {
  const { range } = game.config.engagement;
  if (range === Infinity) return () => true;
  const players = livingPlayers(game);
  return (at) =>
    players.some(
      (player) => Math.hypot(player.x - at.x, player.y - at.y) <= range,
    );
}

/**
 * Whether `body` is in play: a player, or a world entity within the engagement range of a living
 * player.
 */
function inPlay(game: Session, body: Body): boolean {
  return isPlayer(game, body) || inPlayNow(game)(body);
}

/**
 * Whether the body `by`, by id, may act on `body`: always when either is a player, `body` is `by`
 * itself, or `by` is no world entity, such as no body at all; between two world entities, only
 * while both are in play.
 */
export function engages(game: Session, by: string | null, body: Body): boolean {
  const actor = by === null ? undefined : game.entities.get(by);
  if (actor === undefined || actor === body || isPlayer(game, body))
    return true;
  return inPlay(game, actor) && inPlay(game, body);
}

/**
 * Every body out in the world that is not dead: each living player, then each world entity with
 * health left, items lying about included. Ghosts are left out, and so is every body shut away
 * inside a vehicle (see `isShutIn`): nothing out in the world sees, strikes or targets it. So is every body that only some
 * other body than `by`, by id, perceives, and with `by` left out, every body only one perceives.
 * When `by` is a world entity, so is every other world entity it does not engage, as `engages`
 * has it; it keeps itself. With `near` given, only those within its range of its point, edge
 * included: a rule that only reaches so far asks this, so the far bodies cost it a measure alone.
 */
export function livingBodies(
  game: Session,
  by: string | null = null,
  near: Near | null = null,
): Body[] {
  const actor = by === null ? undefined : game.entities.get(by);
  const inPlayAt = inPlayNow(game);
  const engaged =
    actor === undefined
      ? () => true
      : inPlayAt(actor)
        ? (entity: WorldEntity) => entity === actor || inPlayAt(entity)
        : (entity: WorldEntity) => entity === actor;
  const reached = isNear(near);
  return [
    ...playersExposed(game).filter(reached),
    ...[...game.entities.values()].filter(
      // The cheap tests first: each one is a pure test, so their order changes nothing else.
      (entity) =>
        entity.health > 0 &&
        reached(entity) &&
        engaged(entity) &&
        !isShutIn(game, entity) &&
        perceives(game, by, entity.id),
    ),
  ];
}

/** A point and how far from it a rule reaches, edge included. */
export interface Near {
  readonly at: Point;
  readonly range: number;
}

/**
 * Whether a body lies within `near`'s range of its point, measured from that point; every body
 * for none, or a range that is not finite. One at no finite distance counts as near, as the
 * rules that measure past it, such as sight, let it through.
 */
function isNear(near: Near | null): (body: Point) => boolean {
  if (near === null || !Number.isFinite(near.range)) return () => true;
  const { at, range } = near;
  return (body) => !(Math.hypot(body.x - at.x, body.y - at.y) > range);
}

/** Whether the body `id` is gone from the world, dead, or a ghost. */
export function isGone(game: Session, id: string): boolean {
  const body = bodyById(game, id);
  if (body === null) return true;
  const player = asPlayer(game, body);
  return player === null ? body.health <= 0 : isGhost(player);
}

/**
 * The body `id` while it is out in the world and not dead or a ghost; null otherwise, shut away
 * inside a vehicle too, so a monster after it loses it there.
 */
export function livingBody(
  game: Session,
  id: string | null | undefined,
): Body | null {
  const body = bodyById(game, id);
  return body === null || isGone(game, body.id) || isShutIn(game, body)
    ? null
    : body;
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
