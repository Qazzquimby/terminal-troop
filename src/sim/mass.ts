import { asEntity, asPlayer } from "./bodies.js";
import type { Body } from "./bodies.js";
import type { Session } from "./session.js";

/*
 * Every body has a mass, in player masses, which says how hard it is to push. A player weighs what
 * the config says; a world entity what its kind declares, or, when it declares none, what a player
 * of its size would weigh, growing with its area. A kind that cannot be pushed at all, such as the
 * cruiser, weighs Infinity.
 */

/** What a body of `radius` weighs when its kind declares no mass: a player's, scaled by area. */
function massOfSize(game: Session, radius: number): number {
  const { mass, radius: playerRadius } = game.config.player;
  return mass * (radius / playerRadius) ** 2;
}

/** What `body` weighs: a player's configured mass, or its kind's, else one sized to its radius. */
export function massOf(game: Session, body: Body): number {
  if (asPlayer(game, body) !== null) return game.config.player.mass;
  const entity = asEntity(game, body);
  const declared =
    entity === null ? null : game.entityTypes.get(entity.kind)?.mass;
  return declared ?? massOfSize(game, body.radius);
}

/**
 * How much of a push a body of `mass` takes from a pusher of `pusher` mass, 0 to 1: all of it from
 * a pusher at least as heavy, less the heavier it is than the pusher, and none at all for an
 * immovable body (Infinity), however heavy the pusher. A lighter body goes no farther than pushed.
 */
export function pushShare(pusher: number, mass: number): number {
  if (!(mass < Infinity)) return 0;
  if (!(mass > 0)) return 1;
  return Math.max(0, Math.min(1, pusher / mass));
}
