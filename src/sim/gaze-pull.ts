import { isShutIn } from "./aboard.js";
import { perceives } from "./bodies.js";
import type { WorldEntity } from "./entities.js";
import { isGhost } from "./ghosts.js";
import { lerpAngle } from "./interpolation.js";
import { isDeepdark } from "./light.js";
import type { Point } from "./map.js";
import { aimAt } from "./player.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { isStunned } from "./status.js";
import { canSeeFrom } from "./vision.js";

/*
 * A kind can pull the gaze of every body round it (`pullsGaze`): any body with a view cone that
 * could look at one of it just by turning, it lying within the cone's reach along a clear line,
 * whichever way the body faces, has its facing dragged round onto it, as if its eyes were held
 * there. It is the one rule for every body that looks: a player's aim, which its own client turns
 * as it steers, and a world entity's view cone, which `eyesOf` turns. Of several pulling at once,
 * the nearest has it.
 */

/** How a kind pulls the gaze of a body that could look at it. */
export interface GazePull {
  /** Seconds for a facing it catches to be dragged all the way onto it; 0 snaps it there. */
  readonly seconds: number;
}

/** A body pulling gazes now, and how. */
interface Lure {
  readonly entity: WorldEntity;
  readonly pull: GazePull;
}

/** A body's gaze caught by a lure: since when, and when that was last seen to hold. */
interface Grip {
  readonly lure: string;
  readonly since: number;
  last: number;
}

/** Seconds a grip may go unasked after before it is taken for let go, and starts afresh. */
const GRIP_GAP = 0.5;

/** The gazes caught, by the id of the body whose they are, as this client has them. */
const grips = new WeakMap<Session, Map<string, Grip>>();

/** The bodies pulling gazes, gathered once a step: few kinds pull, and eyes are asked often. */
const lures = new WeakMap<
  Session,
  { step: number; count: number; lures: readonly Lure[] }
>();

/** Every living world entity pulling gazes now. */
function luresOf(game: Session): readonly Lure[] {
  const held = lures.get(game);
  if (held?.step === game.step && held.count === game.entities.size)
    return held.lures;
  const found: Lure[] = [];
  for (const entity of game.entities.values()) {
    if (entity.health <= 0) continue;
    const pull = game.entityTypes.get(entity.kind)?.pullsGaze(entity) ?? null;
    if (pull !== null) found.push({ entity, pull });
  }
  lures.set(game, { step: game.step, count: game.entities.size, lures: found });
  return found;
}

/**
 * The lure nearest `looker` that it could look at by turning, its view cone reaching `range`: in
 * reach, which deepdark shortens as it does any look, along a clear line, and perceived by it. Not
 * the looker itself. Null for none.
 */
function lureFor(
  game: Session,
  looker: Point & { readonly id: string },
  range: number,
): Lure | null {
  let best: Lure | null = null;
  let bestDistance = Infinity;
  for (const lure of luresOf(game)) {
    const { entity } = lure;
    if (
      entity.health <= 0 ||
      entity.id === looker.id ||
      !perceives(game, looker.id, entity.id)
    )
      continue;
    const distance = Math.hypot(entity.x - looker.x, entity.y - looker.y);
    if (distance >= bestDistance) continue;
    const reach =
      range * (isDeepdark(game, entity) ? game.config.deepdark.sight : 1);
    if (
      !canSeeFrom(
        game.world.map,
        { x: looker.x, y: looker.y, range: reach },
        entity,
      )
    )
      continue;
    best = lure;
    bestDistance = distance;
  }
  return best;
}

/**
 * The facing `looker` turns to from `facing`, its view cone reaching `range`: dragged onto the
 * nearest lure it could look at, further the longer it has been caught, all the way once the
 * lure's pull has had its seconds; `facing` itself with none. Asked any number of times a step,
 * it gives the same.
 */
export function pulledFacing(
  game: Session,
  looker: Point & { readonly id: string },
  facing: number,
  range: number,
): number {
  const held = grips.get(game) ?? new Map<string, Grip>();
  grips.set(game, held);
  const lure = lureFor(game, looker, range);
  if (lure === null) {
    held.delete(looker.id);
    return facing;
  }
  const now = game.worldTime;
  const kept = held.get(looker.id);
  const grip =
    kept?.lure === lure.entity.id &&
    now - kept.last <= GRIP_GAP &&
    now >= kept.since
      ? kept
      : { lure: lure.entity.id, since: now, last: now };
  grip.last = now;
  held.set(looker.id, grip);
  const { seconds } = lure.pull;
  const share = seconds > 0 ? Math.min(1, (now - grip.since) / seconds) : 1;
  return lerpAngle(facing, aimAt(looker, lure.entity), share);
}

/**
 * The aim `player` turns to from `aim`, which its controls gave: pulled as any body's facing is,
 * down its own view cone's reach. A body that sees nothing (a ghost, the stunned) or is shut away
 * inside a vehicle is not pulled.
 */
export function pulledAim(game: Session, player: Player, aim: number): number {
  if (isGhost(player) || isStunned(game, player.id) || isShutIn(game, player))
    return aim;
  return pulledFacing(game, player, aim, game.config.vision.lookRange);
}
