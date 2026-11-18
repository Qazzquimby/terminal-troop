import { z } from "zod";
import { onScreenAngle, upright } from "../../lib/upright/index.js";
import { drawEmoji } from "../../render/index.js";
import { defineEntity, isAreaFree, rounded, sound } from "../../sim/index.js";
import type {
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { playEach, preyFor, touching } from "../bodies.js";
import { Route, strikeEach, strikeIf, Time, walk } from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const bellUrl = new URL("./sfx/bell.mp3", import.meta.url).href;
const creakUrl = new URL("./sfx/creak.mp3", import.meta.url).href;
const hitUrl = new URL("./sfx/bell.mp3", import.meta.url).href;

/**
 * The tricycle: rides on and on along the wide ways, rarely doubling back, through every body but
 * those it runs down. `targets` (players, as shipped) are what it runs down: it rings at them,
 * slows for them and strikes them; every other body it passes through. Distances in pixels, times
 * in sim seconds.
 */
export interface TricycleConfig extends Hunting, Dormancy {
  /** How the world's spawner brings them. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its speed, as a share of a player's walk. */
  readonly speedShare: number;
  /** Its speed while a body it runs down is near and ahead of it, as a share of a walk. */
  readonly slowShare: number;
  /** How near a body it runs down must be, ahead of it, to slow it. */
  readonly slowRange: number;
  /**
   * Its rides: to spots `min` to `max` off, as the crow flies, the one heading most nearly the way
   * it already faces of `tries` tried, along ways at least `width` across where there are any.
   * While any body it runs down is about, it rides only to spots within `near` of one.
   */
  readonly ride: {
    readonly min: number;
    readonly max: number;
    readonly tries: number;
    readonly width: number;
    readonly near: number;
  };
  /** How far down its way it rings at a body it runs down standing on it. */
  readonly bellRange: number;
  /** Seconds between two rings of its bell. */
  readonly bellCooldown: number;
  /** Damage dealt to each body it runs down that it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** Seconds between creaks of its wheels as it rides. */
  readonly creakInterval: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly bell: number;
    readonly creak: number;
    readonly hit: number;
  };
}

const NAME = "tricycle";

const GLYPH = "🚲";

/** Seconds its bell shows over it after a ring. */
const BELL_SHOWN = 0.6;

/**
 * Everyone reads its facing, whether it slows and when it last rang, to draw it; the rest only
 * the host reads.
 */
export const TricycleState = z.object({
  route: Route,
  facing: rounded(2),
  slowed: z.boolean(),
  bellAt: Time,
  rangAt: Time.nullable(),
  creakAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
});

export type TricycleState = z.output<typeof TricycleState>;

/** A fresh tricycle's state at world time `now`, facing `facing`. */
export function freshTricycle(now: number, facing = 0): TricycleState {
  return {
    route: [],
    facing,
    slowed: false,
    bellAt: now,
    rangAt: null,
    creakAt: now,
    attackAt: now,
    attacking: false,
  };
}

/** The bodies it runs down: those it would hunt, `targets` as configured. */
function quarries(game: Session, self: WorldEntity, config: TricycleConfig) {
  return preyFor(game, self, config);
}

/** The way from `from` to `to` along ways wide enough where there is one, else any. */
function wideRoute(
  game: Session,
  self: WorldEntity,
  to: Point,
  config: TricycleConfig,
): Point[] | null {
  const { map } = game.world;
  const half = Math.max(self.radius, config.ride.width / 2);
  return (
    planRoute(map, half, self, to) ?? planRoute(map, self.radius, self, to)
  );
}

/** `tries` spots evenly round `self`, each `min` to `max` off, from a random start. */
function spotsRound(self: Point, config: TricycleConfig): Point[] {
  const { min, max, tries } = config.ride;
  const offset = Math.random() * Math.PI * 2;
  return Array.from({ length: tries }, (_, attempt) => {
    const angle = offset + (attempt / tries) * Math.PI * 2;
    const distance = min + (max - min) * Math.random();
    return {
      x: self.x + Math.cos(angle) * distance,
      y: self.y + Math.sin(angle) * distance,
    };
  });
}

/** `tries` spots each within `near` of one of `bodies`, drawn at random; none for no bodies. */
function spotsNear(bodies: readonly Point[], config: TricycleConfig): Point[] {
  const { tries, near } = config.ride;
  return Array.from({ length: tries }).flatMap(() => {
    const body = bodies[Math.floor(Math.random() * bodies.length)];
    if (body === undefined) return [];
    const angle = Math.random() * Math.PI * 2;
    // Spread evenly over the disc, not bunched at its middle.
    const distance = near * Math.sqrt(Math.random());
    return [
      {
        x: body.x + Math.cos(angle) * distance,
        y: body.y + Math.sin(angle) * distance,
      },
    ];
  });
}

/**
 * Where it may ride next: spots round it, but, while any of `bodies` it runs down is about, only
 * those within its `near` of one; should none be, spots round those bodies instead, so it never
 * strays far from them.
 */
function destinations(
  self: Point,
  bodies: readonly Point[],
  config: TricycleConfig,
): Point[] {
  const round = spotsRound(self, config);
  if (bodies.length === 0) return round;
  const { near } = config.ride;
  const nearOne = round.filter((spot) =>
    bodies.some((body) => Math.hypot(body.x - spot.x, body.y - spot.y) <= near),
  );
  return nearOne.length > 0 ? nearOne : spotsNear(bodies, config);
}

/**
 * Its next ride, once the last is done: of the spots it may ride to (see `destinations`), those
 * it fits at, the one whose way sets off most nearly the way it faces, so it doubles back only
 * when nothing else goes. Empty when none is reached.
 */
function nextRide(
  game: Session,
  self: WorldEntity,
  facing: number,
  bodies: readonly Point[],
  config: TricycleConfig,
): Point[] {
  const { map } = game.world;
  let best: { route: Point[]; score: number } | null = null;
  for (const to of destinations(self, bodies, config)) {
    if (!isAreaFree(map, to.x, to.y, self.radius)) continue;
    const route = wideRoute(game, self, to, config);
    if (route === null) continue;
    // The way it sets off: to the first waypoint a cell off, past any it all but stands on.
    const first =
      route.find(
        (point) => Math.hypot(point.x - self.x, point.y - self.y) >= map.cell,
      ) ?? route.at(-1);
    if (first === undefined) continue;
    const setsOff = Math.atan2(first.y - self.y, first.x - self.x);
    const score = Math.cos(setsOff - facing);
    if (best === null || score > best.score) best = { route, score };
  }
  return best?.route ?? [];
}

/** How far `at` is from the segment `a` to `b`. */
function fromSegment(at: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / length),
        );
  return Math.hypot(at.x - (a.x + dx * t), at.y - (a.y + dy * t));
}

/**
 * Whether `body` stands on its way within `range` of it: near enough the line of its route, from
 * where it stands, that it would ride into it.
 */
export function onWay(
  self: Point & { readonly radius: number },
  route: readonly Point[],
  body: Point & { readonly radius: number },
  range: number,
): boolean {
  if (Math.hypot(body.x - self.x, body.y - self.y) > range) return false;
  const reach = self.radius + body.radius;
  let from: Point = self;
  for (const to of route) {
    if (fromSegment(body, from, to) <= reach) return true;
    from = to;
  }
  return false;
}

/** Whether `body` is within `range` of it and ahead of it, the way it faces. */
function approaching(
  self: Point,
  facing: number,
  body: Point,
  range: number,
): boolean {
  const dx = body.x - self.x;
  const dy = body.y - self.y;
  if (Math.hypot(dx, dy) > range) return false;
  return dx * Math.cos(facing) + dy * Math.sin(facing) > 0;
}

/**
 * Rides on: a fresh ride once the last is done; it rings when a body it runs down stands on its
 * way, slows when one is near and ahead, and strikes those it touches.
 */
function think(
  state: TricycleState,
  self: WorldEntity,
  game: Session,
  config: TricycleConfig,
): TricycleState {
  const now = game.worldTime;
  const bodies = quarries(game, self, config);
  const route =
    state.route.length > 0
      ? state.route
      : nextRide(game, self, state.facing, bodies, config);
  const blocked = bodies.some((body) =>
    onWay(self, route, body, config.bellRange),
  );
  const rings = blocked && now >= state.bellAt;
  const slowed = bodies.some((body) =>
    approaching(self, state.facing, body, config.slowRange),
  );
  const struck = runOver(game, self, config);
  const creaks = route.length > 0 && now >= state.creakAt;
  return strikeIf(
    {
      ...state,
      route,
      slowed,
      bellAt: rings ? now + config.bellCooldown : state.bellAt,
      rangAt: rings ? now : state.rangAt,
      creakAt: creaks ? now + config.creakInterval : state.creakAt,
    },
    now,
    struck.length > 0,
    config.attackCooldown,
  );
}

/** The bodies it runs down that it touches. */
function runOver(game: Session, self: WorldEntity, config: TricycleConfig) {
  const bodies = new Set(quarries(game, self, config).map(({ id }) => id));
  return touching(game, self, config.ignores).filter(({ id }) =>
    bodies.has(id),
  );
}

interface Sounds {
  readonly bell: Sound;
  readonly creak: Sound;
  readonly hit: Sound;
}

/** Sounds, as the host, on every client, a ring, a creak of its wheels, or a body run down. */
function cue(
  self: WorldEntity,
  previous: TricycleState,
  next: TricycleState,
  game: Session,
  sounds: Sounds,
): void {
  playEach(game, self, [
    next.rangAt !== previous.rangAt && sounds.bell,
    next.creakAt !== previous.creakAt && sounds.creak,
    next.attacking && sounds.hit,
  ]);
}

function definition(config: TricycleConfig): EntityDefinition<TricycleState> {
  const sounds: Sounds = {
    bell: sound({ url: bellUrl, range: config.sounds.bell }),
    creak: sound({ url: creakUrl, range: config.sounds.creak }),
    hit: sound({ url: hitUrl, range: config.sounds.hit }),
  };
  const speedOf = (game: Session, slowed: boolean): number =>
    game.config.player.speed * (slowed ? config.slowShare : config.speedShare);
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    // It rides through every body; those it runs down, it strikes as it passes.
    collides: false,
    data: TricycleState,
    update(entity, state, dt, game) {
      const next = think(state, entity, game, config);
      cue(entity, state, next, game, sounds);
      const moved = walk(entity, next, speedOf(game, next.slowed), dt);
      // Passing through bodies, it does not meet walls as a body does: its way keeps it clear of
      // them, and one in the way since it planned stops it, to plan anew.
      const ahead = isAreaFree(
        game.world.map,
        entity.x + entity.vx * dt,
        entity.y + entity.vy * dt,
        entity.radius,
      );
      if (ahead) return moved;
      entity.vx = 0;
      entity.vy = 0;
      return { ...moved, route: [] };
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return strikeEach(runOver(game, entity, config), config.damage);
    },
    draw(ctx, entity, state, _now, game) {
      // It faces the way it rides on the screen, leaning as it goes, however the camera turns.
      const flip = Math.cos(onScreenAngle(ctx, state.facing)) < 0;
      upright(ctx, entity, () => {
        ctx.save();
        ctx.translate(entity.x, entity.y);
        if (flip) ctx.scale(-1, 1);
        drawEmoji(ctx, { x: 0, y: 0 }, GLYPH, entity.radius * 2);
        ctx.restore();
      });
      const rang = state.rangAt;
      if (rang !== null && game.worldTime - rang < BELL_SHOWN) {
        drawEmoji(
          ctx,
          { x: entity.x, y: entity.y - entity.radius * 1.8 },
          "🔔",
          entity.radius,
        );
      }
    },
  };
}

/**
 * The tricycle: no one rides it, but it rides on all the same, along the wide ways, picking each
 * ride to set off the way it already heads, so it rarely doubles back, and never to a spot far
 * from every body it runs down, so it keeps coming back round to them. It passes through every
 * body but those it runs down, players as shipped, and those it strikes hard as it passes. One
 * standing on its way ahead hears its bell; near and ahead of it, it slows. Its wheels creak as it
 * goes.
 */
export const tricycle = defineEntity(NAME, (config: TricycleConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (seed: number, game: Session) =>
      freshTricycle(game.worldTime, seed * Math.PI * 2),
  }),
}));
