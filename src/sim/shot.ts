import { effect, hurt } from "./actions.js";
import type { WorldEntity } from "./entities.js";
import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";
import { distanceToWall } from "./vision.js";

/** A straight shot. Distances in pixels. */
export interface Shot {
  /** Which way it flies, in radians. */
  readonly aim: number;
  /** How far it carries when nothing stops it. */
  readonly range: number;
  /** Damage dealt to the first body it meets. */
  readonly damage: number;
}

/** Where a traced shot stopped, and what stopped it. */
export interface ShotEnd {
  readonly end: Point;
  /** The body it met first, if any. */
  readonly struck: Player | WorldEntity | null;
  /** Whether a wall stopped it. */
  readonly wall: boolean;
}

/** The bodies a shot can meet: every player and every solid world entity, but `but`. */
function targets(game: Session, but: string): (Player | WorldEntity)[] {
  return [
    ...[...game.players.values()].filter((player) => player.id !== but),
    ...[...game.entities.values()].filter(
      (entity) => entity.collides && entity.id !== but,
    ),
  ];
}

/**
 * How far along the unit vector `direction` from `from` a ray first touches `body`; null when it
 * misses it or the body is behind. A ray from inside a body touches it at once.
 */
function rayToBody(
  from: Point,
  direction: Point,
  body: Point & { readonly radius: number },
): number | null {
  const dx = body.x - from.x;
  const dy = body.y - from.y;
  const along = dx * direction.x + dy * direction.y;
  const squared = dx * dx + dy * dy;
  const reach = body.radius * body.radius;
  if (squared <= reach) return 0;
  if (along <= 0) return null;
  const across = squared - along * along;
  if (across > reach) return null;
  return along - Math.sqrt(reach - across);
}

/**
 * Traces a shot from `from` the way `aim` (radians) faces, as far as `range`: it stops at the
 * first wall or body in its way, never the body with id `but`, its shooter.
 */
export function traceShot(
  game: Session,
  from: Point,
  aim: number,
  range: number,
  but: string,
): ShotEnd {
  const direction = { x: Math.cos(aim), y: Math.sin(aim) };
  const toWall = distanceToWall(game.world.map, from, direction, range);
  let distance = toWall;
  let struck: Player | WorldEntity | null = null;
  for (const body of targets(game, but)) {
    const to = rayToBody(from, direction, body);
    if (to === null || to > distance) continue;
    distance = to;
    struck = body;
  }
  return {
    end: {
      x: from.x + direction.x * distance,
      y: from.y + direction.y * distance,
    },
    struck,
    wall: struck === null && toWall < range,
  };
}

/** What a shot shows: its tracer's spark where it stops, in pixels. */
export interface ShotLook {
  readonly spark: number;
}

/**
 * Fires `shot` from where `shooter` stands, as part of an action or, outside one, on the host:
 * the first body in its way takes its damage, friend or foe, and every client sees its tracer
 * from the shooter's edge to where it stopped. Walls stop it. Returns where it stopped and why.
 */
export function shoot(
  game: Session,
  shooter: Point & { readonly id: string; readonly radius: number },
  shot: Shot,
  look: ShotLook,
): ShotEnd {
  const from = { x: shooter.x, y: shooter.y };
  const ended = traceShot(game, from, shot.aim, shot.range, shooter.id);
  if (ended.struck !== null) hurt(game, ended.struck, shot.damage);
  const muzzle = Math.min(
    shooter.radius,
    Math.hypot(ended.end.x - from.x, ended.end.y - from.y),
  );
  effect(
    game,
    {
      at: ended.end,
      flash: {
        radius: look.spark,
        hit: ended.struck !== null,
        from: {
          x: from.x + Math.cos(shot.aim) * muzzle,
          y: from.y + Math.sin(shot.aim) * muzzle,
        },
      },
    },
    shooter,
  );
  return ended;
}

/** `count` aims spread evenly across `arc` radians, centred on `aim`; just `aim` for one. */
export function fan(aim: number, arc: number, count: number): number[] {
  if (count <= 1) return [aim];
  return Array.from(
    { length: count },
    (_, i) => aim - arc / 2 + (arc * i) / (count - 1),
  );
}
