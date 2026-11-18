import { z } from "zod";
import { onScreenAngle, upright } from "../../lib/upright/index.js";
import { drawEmoji } from "../../render/index.js";
import { defineEntity, isAreaFree, rounded, sound } from "../../sim/index.js";
import type {
  Body,
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  TileMap,
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
   * Its rides: to spots `min` to `max` off, as the crow flies, along ways at least `width` across
   * where there are any. It tries `tries` spots round it and `through` spots past bodies it runs
   * down, each `overshoot` beyond one; while any such body is about, it rides only to spots within
   * `near` of one. Of those it reaches, it takes the one that best sets off the way it faces, plus
   * `pull` for a ride whose way passes within `pass` of a body it runs down that it has not passed
   * in the last `rest` seconds (a share of `pull` for one passed more lately).
   */
  readonly ride: {
    readonly min: number;
    readonly max: number;
    readonly tries: number;
    readonly through: number;
    readonly overshoot: { readonly min: number; readonly max: number };
    readonly width: number;
    readonly near: number;
    readonly pass: number;
    readonly pull: number;
    readonly rest: number;
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

/** What a short ride loses of its score: more than any setting off and pass can make up. */
const SHORT = 100;

/** Seconds its bell shows over it after a ring. */
const BELL_SHOWN = 0.6;

/**
 * Everyone reads its facing, whether it slows and when it last rang, to draw it; the rest only
 * the host reads.
 */
export const TricycleState = z.object({
  route: Route,
  facing: rounded(2),
  // When it last passed each body it runs down, by id, until `ride.rest` has run out.
  passed: z.record(z.string(), Time),
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
    passed: {},
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
 * `through` spots past `bodies`, each on the far side of one drawn at random, as seen from `self`,
 * give or take an eighth of a turn: `overshoot` beyond it, further should that leave the ride
 * under `min`, but never past `near`; should that spot be in a wall, the nearest it fits at back
 * along the line, a cell at a time, while still `pass` beyond. Riding to one, it rides by that
 * body and on, rather than up to it to turn round.
 */
function spotsPast(
  map: TileMap,
  self: WorldEntity,
  bodies: readonly Point[],
  config: TricycleConfig,
): Point[] {
  const { through, overshoot, min, near, pass } = config.ride;
  return Array.from({ length: through }).flatMap(() => {
    const body = bodies[Math.floor(Math.random() * bodies.length)];
    if (body === undefined) return [];
    const off = Math.hypot(body.x - self.x, body.y - self.y);
    const angle =
      Math.atan2(body.y - self.y, body.x - self.x) +
      (Math.random() - 0.5) * (Math.PI / 4);
    const sampled =
      overshoot.min + (overshoot.max - overshoot.min) * Math.random();
    for (
      let beyond = Math.min(near, Math.max(sampled, min - off));
      beyond > pass;
      beyond -= map.cell
    ) {
      const spot = {
        x: body.x + Math.cos(angle) * beyond,
        y: body.y + Math.sin(angle) * beyond,
      };
      if (isAreaFree(map, spot.x, spot.y, self.radius)) return [spot];
    }
    return [];
  });
}

/**
 * Where it may ride next: spots round it, but, while any of `bodies` it runs down is about, only
 * those within its `near` of one (should none be, spots round those bodies instead, so it never
 * strays far from them), and spots past those bodies.
 */
function destinations(
  map: TileMap,
  self: WorldEntity,
  bodies: readonly Point[],
  config: TricycleConfig,
): Point[] {
  const round = spotsRound(self, config);
  if (bodies.length === 0) return round;
  const { near } = config.ride;
  const nearOne = round.filter((spot) =>
    bodies.some((body) => Math.hypot(body.x - spot.x, body.y - spot.y) <= near),
  );
  return [
    ...(nearOne.length > 0 ? nearOne : spotsNear(bodies, config)),
    ...spotsPast(map, self, bodies, config),
  ];
}

/**
 * How much it wants to pass `body` at `now`, `passed` the last time it passed each: not at all
 * just after passing it, rising to wholly once `rest` has run out.
 */
function freshness(
  passed: Readonly<Record<string, number>>,
  body: Body,
  now: number,
  rest: number,
): number {
  const at = passed[body.id];
  if (at === undefined || rest <= 0) return 1;
  return Math.min(1, Math.max(0, (now - at) / rest));
}

/**
 * Whether `route`, ridden from `from`, rides by `body`: within `range` of it on the way, and on
 * to end more than `range` past it, not at it.
 */
function ridesBy(
  from: Point,
  route: readonly Point[],
  body: Point,
  range: number,
): boolean {
  const end = route.at(-1);
  if (end === undefined) return false;
  if (Math.hypot(end.x - body.x, end.y - body.y) <= range) return false;
  return passes(from, route, body, range);
}

/** How far `route` runs, ridden from `from`. */
function lengthOf(from: Point, route: readonly Point[]): number {
  let length = 0;
  let a = from;
  for (const b of route) {
    length += Math.hypot(b.x - a.x, b.y - a.y);
    a = b;
  }
  return length;
}

/** Whether `route`, ridden from `from`, passes within `range` of `body`. */
function passes(
  from: Point,
  route: readonly Point[],
  body: Point,
  range: number,
): boolean {
  let a = from;
  for (const b of route) {
    if (fromSegment(body, a, b) <= range) return true;
    a = b;
  }
  return false;
}

/**
 * Its next ride, once the last is done: of the spots it may ride to (see `destinations`), those
 * it fits at, the one scoring best: how nearly its way sets off the way it faces, so it doubles
 * back only when nothing else goes, plus `pull` times the freshest body it runs down that the way
 * rides by (on past it, not to it), so it rides by one it has not lately passed. Empty when none
 * is reached.
 */
function nextRide(
  game: Session,
  self: WorldEntity,
  state: TricycleState,
  bodies: readonly Body[],
  config: TricycleConfig,
): Point[] {
  const { map } = game.world;
  const { pass, pull, rest } = config.ride;
  const wants = bodies.map((body) => ({
    body,
    fresh: freshness(state.passed, body, game.worldTime, rest),
  }));
  let best: { route: Point[]; score: number } | null = null;
  for (const to of destinations(map, self, bodies, config)) {
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
    let drawn = 0;
    for (const { body, fresh } of wants)
      if (fresh > drawn && ridesBy(self, route, body, pass)) drawn = fresh;
    // A ride short of `min` along its way, its end nudged in off the walls, goes only when no
    // longer one does.
    const short = lengthOf(self, route) < config.ride.min ? SHORT : 0;
    const score = Math.cos(setsOff - state.facing) + pull * drawn - short;
    if (best === null || score > best.score) best = { route, score };
  }
  return best?.route ?? [];
}

/**
 * `passed` brought up to `now`: each of `bodies` within `ride.pass` of `self` passed now, and any
 * passed `ride.rest` or more ago forgotten, so it keeps only what still sways it.
 */
function passing(
  passed: Readonly<Record<string, number>>,
  self: Point,
  bodies: readonly Body[],
  now: number,
  config: TricycleConfig,
): Record<string, number> {
  const { pass, rest } = config.ride;
  const kept = Object.fromEntries(
    Object.entries(passed).filter(([, at]) => now - at < rest),
  );
  for (const body of bodies)
    if (Math.hypot(body.x - self.x, body.y - self.y) <= pass)
      kept[body.id] = now;
  return kept;
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
  return passes(self, route, body, self.radius + body.radius);
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
  const passed = passing(state.passed, self, bodies, now, config);
  const route =
    state.route.length > 0
      ? state.route
      : nextRide(game, self, { ...state, passed }, bodies, config);
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
      passed,
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
 * from every body it runs down. It sweeps by them rather than at them: its rides are long, and it
 * takes one whose way passes a body it runs down, on and past it, over one that does not,
 * favouring whichever it has gone longest without passing, so among many it does the rounds. It passes through every
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
