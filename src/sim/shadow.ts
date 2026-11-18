import { isAboard } from "./aboard.js";
import { isGhost } from "./ghosts.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";
import type { Footprint } from "./shape.js";
import { axesOf } from "./shape.js";

/*
 * Shadows (#384). Every body standing in the world blocks the lights given off and carried round
 * it, as a wall does: a light reaches through a body, lighting all of it, and stops at its far
 * side, so behind it, away from the light, lies its shadow. Only a place's own light, sunlight
 * out of doors or a room's fixture, which comes from no one point, casts none.
 *
 * A body's own lights shine out past it, so a light never falls in the shadow of a body it shines
 * from within. A kind can say it casts none (`castsShadow`), as something lying flat on the
 * ground does, and an apparition casts none while it shows as one.
 */

/** A body that casts a shadow, by its footprint: its disc, or its box. */
export interface Occluder extends Footprint {
  readonly id: string;
}

/** How tolerant, in pixels, the far side of a body is of a point on it: that point is lit. */
const EDGE = 1e-6;

/** Angles either side of a body's edge a ray is cast at, so its shadow's edge is sharp. */
const EDGE_ANGLE = 1e-7;

/** How far from its centre any part of `body` lies, at most. */
const reachOf = (body: Footprint): number =>
  body.box === null || body.box === undefined
    ? body.radius
    : Math.hypot(body.box.length, body.box.width) / 2;

/** Where `point` lies relative to `body`'s centre, along and across its box. */
function inBox(body: Footprint, point: Point): Point {
  const { along, across } = axesOf(body.box?.heading ?? 0);
  const x = point.x - body.x;
  const y = point.y - body.y;
  return { x: x * along.x + y * along.y, y: x * across.x + y * across.y };
}

/** Whether `point` lies within `body`, its edge included. */
function contains(body: Footprint, point: Point): boolean {
  const { box } = body;
  if (box === null || box === undefined)
    return Math.hypot(point.x - body.x, point.y - body.y) <= body.radius;
  const at = inBox(body, point);
  return Math.abs(at.x) <= box.length / 2 && Math.abs(at.y) <= box.width / 2;
}

/**
 * How far along the ray from `origin` down the unit vector `direction` it leaves `body` by its
 * far side, having passed through it; null for a ray that misses it, or starts within it.
 */
export function exitAlong(
  body: Footprint,
  origin: Point,
  direction: Point,
): number | null {
  const { box } = body;
  if (box === null || box === undefined) {
    const fx = origin.x - body.x;
    const fy = origin.y - body.y;
    const c = fx * fx + fy * fy - body.radius * body.radius;
    if (c <= 0) return null;
    const b = fx * direction.x + fy * direction.y;
    const disc = b * b - c;
    if (disc <= 0) return null;
    const far = -b + Math.sqrt(disc);
    return far > 0 ? far : null;
  }
  const from = inBox(body, origin);
  const way = inBox({ x: 0, y: 0, radius: 0, box }, direction);
  const halves = [
    [from.x, way.x, box.length / 2],
    [from.y, way.y, box.width / 2],
  ] as const;
  if (halves.every(([at, , half]) => Math.abs(at) < half)) return null;
  let enter = -Infinity;
  let leave = Infinity;
  for (const [at, step, half] of halves) {
    if (Math.abs(step) < 1e-12) {
      if (Math.abs(at) > half) return null;
      continue;
    }
    const a = (-half - at) / step;
    const b = (half - at) / step;
    enter = Math.max(enter, Math.min(a, b));
    leave = Math.min(leave, Math.max(a, b));
  }
  return leave > Math.max(enter, 0) ? leave : null;
}

/**
 * Those of `occluders` that can shadow anything a light at `origin` reaching `range` lights:
 * those within its reach, but not one it shines from within.
 */
export function shadowing(
  occluders: readonly Occluder[],
  origin: Point,
  range: number,
): Occluder[] {
  return occluders.filter(
    (body) =>
      Math.hypot(body.x - origin.x, body.y - origin.y) <
        range + reachOf(body) && !contains(body, origin),
  );
}

/** A light as shadows bear on it: where it shines from, and how far, unbounded when left out. */
type Shone = Point & { readonly range?: number };

/** The bodies that can shadow what a light lights, as `shadowing` has them, for each light. */
export type ShadowsOf = (light: Shone) => readonly Occluder[];

/** No body shadows any light. */
export const noShadows: ShadowsOf = () => [];

/**
 * Those of `occluders` that can shadow each light, as `shadowing` has them, found once for each
 * light asked of, so a caller asking of many points in the same lights pays for it once.
 */
export function shadowsOf(occluders: readonly Occluder[]): ShadowsOf {
  if (occluders.length === 0) return noShadows;
  const found = new WeakMap<Shone, Occluder[]>();
  return (light) => {
    const known = found.get(light);
    if (known !== undefined) return known;
    const near = shadowing(occluders, light, light.range ?? Infinity);
    found.set(light, near);
    return near;
  };
}

/**
 * How far a ray from `origin` down the unit vector `direction` goes before the far side of the
 * first of `occluders` it passes through stops it, at most `maxDist`.
 */
export function occludedDistance(
  occluders: readonly Occluder[],
  origin: Point,
  direction: Point,
  maxDist: number,
): number {
  let distance = maxDist;
  for (const body of occluders) {
    const exit = exitAlong(body, origin, direction);
    if (exit !== null && exit < distance) distance = exit;
  }
  return distance;
}

/**
 * Whether one of `occluders` shadows `point` from a light at `from`: the line between them passes
 * through it and out its far side short of `point`. A point within a body is never in its own
 * shadow, so a body in a light is lit, all of it; nor in the shadow of a body it shines from
 * within. The body `ignore`, by id, casts none here: as a body judges where is lit, its own
 * shadow, which goes where it goes, is no matter.
 */
export function inShadow(
  occluders: readonly Occluder[],
  from: Point,
  point: Point,
  ignore: string | null = null,
): boolean {
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return false;
  const direction = { x: dx / distance, y: dy / distance };
  const midX = (from.x + point.x) / 2;
  const midY = (from.y + point.y) / 2;
  return occluders.some((body) => {
    if (body.id === ignore) return false;
    // Only a body near the line between them can lie across it.
    const near = distance / 2 + reachOf(body);
    if (Math.abs(body.x - midX) > near || Math.abs(body.y - midY) > near)
      return false;
    // A ray from within a body finds no far side to it: a light shines out of what gives it off.
    const exit = exitAlong(body, from, direction);
    return exit !== null && exit < distance - EDGE;
  });
}

/**
 * The angles from `origin` at which `occluders` have their edges, a hair either side of each, for
 * a traced light to cast rays at so the shadows' edges are sharp.
 */
export function edgeAngles(
  occluders: readonly Occluder[],
  origin: Point,
): number[] {
  const angles: number[] = [];
  for (const body of occluders) {
    const { box } = body;
    const edges: number[] = [];
    if (box === null || box === undefined) {
      const distance = Math.hypot(body.x - origin.x, body.y - origin.y);
      if (distance <= body.radius) continue;
      const towards = Math.atan2(body.y - origin.y, body.x - origin.x);
      const half = Math.asin(body.radius / distance);
      edges.push(towards - half, towards + half);
    } else {
      const { along, across } = axesOf(box.heading);
      for (const [l, w] of [
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ] as const) {
        const x =
          body.x + (along.x * l * box.length + across.x * w * box.width) / 2;
        const y =
          body.y + (along.y * l * box.length + across.y * w * box.width) / 2;
        edges.push(Math.atan2(y - origin.y, x - origin.x));
      }
    }
    for (const edge of edges)
      angles.push(edge - EDGE_ANGLE, edge, edge + EDGE_ANGLE);
  }
  return angles;
}

/**
 * Every body in `game` that casts a shadow now: each living player out in the world, not aboard
 * a vehicle, and each world entity but those of a kind that casts none, one only some body
 * perceives, or one showing as an apparition. None at all while the light config's shadows are
 * off.
 */
export function shadowCasters(game: Session): Occluder[] {
  if (!game.config.light.shadows.cast) return [];
  const casters: Occluder[] = [];
  game.players.forEach((player) => {
    if (isGhost(player) || isAboard(player)) return;
    casters.push({
      id: player.id,
      x: player.x,
      y: player.y,
      radius: player.radius,
    });
  });
  game.entities.forEach((entity) => {
    const type = game.entityTypes.get(entity.kind);
    if (type === undefined || !type.castsShadow || type.restricted) return;
    if (type.apparition(entity) !== null) return;
    casters.push({
      id: entity.id,
      x: entity.x,
      y: entity.y,
      radius: entity.radius,
      box: type.box(entity),
    });
  });
  return casters;
}
