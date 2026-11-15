import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  defineEntity,
  distanceToWall,
  effect,
  eyesOf,
  hasKindTag,
  hurtSinceLastStep,
  inCone,
  livingBodies,
  livingBody,
  rounded,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import type { Hunting } from "../hunt.js";
import {
  nearest,
  Route,
  strikeEach,
  strikeIf,
  Time,
  walk,
  Waypoint,
  avenged,
} from "../hunt.js";
import { drawRing, nearestPrey, preyFor, touching } from "../bodies.js";
import { avoidingWhere, planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const retreatUrl = new URL("./sfx/retreat.mp3", import.meta.url).href;
const enragedUrl = new URL("./sfx/enraged.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/**
 * The stalker: knows where every body is and which way it faces, creeps up on the nearest out
 * of everyone's sight, backs off when looked at, and goes wild when hurt. Distances in pixels,
 * times in sim seconds.
 */
export interface StalkerConfig extends Hunting {
  /** How the world's spawner brings them. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its speed, in pixels a second. */
  readonly speed: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /**
   * How far down a body's view cone it counts as watched, light or no light: as far as that body
   * looks, but never past this.
   */
  readonly watchRange: number;
  /** Least distance a retreat keeps from every body it hunts, where it can. */
  readonly retreatDistance: number;
  /** Seconds a retreat lasts before it hunts again. */
  readonly retreatSeconds: number;
  /** Seconds its rage lasts before it hunts again. */
  readonly enragedSeconds: number;
  /** Seconds between plans of its route. */
  readonly repathInterval: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly retreat: number;
    readonly enraged: number;
    readonly attack: number;
  };
}

const NAME = "stalker";

const GLYPH = "👤";

/** A cell's middle and its four corners, as offsets from the middle. */
const CORNERS = [
  [0, 0],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

const COLOURS = {
  hunt: "#4b4f63",
  retreat: "#7e8bb0",
  enraged: "#e0302a",
} as const;

/**
 * Everyone reads its mode, to draw it, and its facing; the rest only the host reads.
 * - hunt: heads for the nearest living body it hunts by a way no body watches
 * - retreat: heads home, keeping its distance from every body it hunts, until `until`
 * - enraged: runs straight at `foe`, while it lives, or else the nearest living body, until `until`
 * `home` is where it arrived, null until it first steps; `foe` is the body that last hurt it,
 * which it goes for while enraged.
 */
export const StalkerState = z.object({
  mode: z.enum(["hunt", "retreat", "enraged"]),
  until: Time,
  home: Waypoint.nullable(),
  route: Route,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  foe: z.string().nullable(),
  facing: rounded(2),
});

export type StalkerState = z.output<typeof StalkerState>;

type Mode = StalkerState["mode"];

/** A fresh stalker's state at world time `now`. */
export function freshStalker(now: number): StalkerState {
  return {
    mode: "hunt",
    until: now,
    home: null,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
    foe: null,
    facing: 0,
  };
}

/**
 * Whether any living body but the kinds it ignores watches a point: it lies within that body's
 * view cone, as far as it looks but no further than the watch range, with nothing in the way.
 * Light plays no part, nor what lies behind a body. A stunned or blind body watches nothing.
 */
function watcher(
  game: Session,
  self: WorldEntity,
  config: StalkerConfig,
): (at: Point) => boolean {
  const sights = livingBodies(game)
    .filter(
      (body) =>
        body.id !== self.id && !hasKindTag(game, body.id, config.ignores),
    )
    .map((body) => eyesOf(game, body))
    .filter((sight) => (sight?.cone ?? null) !== null);
  return (at) =>
    sights.some((sight) => inCone(game, sight, at, config.watchRange));
}

/** How far `at` is from the nearest of `bodies`; Infinity with none. */
function distanceFrom(bodies: readonly Point[], at: Point): number {
  const body = nearest(at, bodies);
  return body === null ? Infinity : Math.hypot(body.x - at.x, body.y - at.y);
}

/**
 * Its way home keeping at least the retreat distance from every body it hunts, or, while one is
 * already nearer than that, never nearer than it stands now. With no such way, straight away from
 * the nearest as far as the walls let it run.
 */
function retreatRoute(
  game: Session,
  self: WorldEntity,
  home: Point,
  config: StalkerConfig,
): Point[] {
  const { map } = game.world;
  const hunted = preyFor(game, self, config);
  const keep = Math.min(config.retreatDistance, distanceFrom(hunted, self));
  const avoid = avoidingWhere(map, (at) => distanceFrom(hunted, at) < keep);
  const route = planRoute(map, self.radius, self, home, avoid);
  if (route !== null) return route;
  const body = nearest(self, hunted);
  if (body === null) return [];
  const away = Math.atan2(self.y - body.y, self.x - body.x);
  const direction = { x: Math.cos(away), y: Math.sin(away) };
  const run =
    distanceToWall(map, self, direction, config.retreatDistance) - self.radius;
  if (run <= 0) return [];
  return [{ x: self.x + direction.x * run, y: self.y + direction.y * run }];
}

/** Its route for its mode, planned now. */
function plan(
  game: Session,
  self: WorldEntity,
  state: StalkerState,
  config: StalkerConfig,
): Point[] {
  const { map } = game.world;
  switch (state.mode) {
    case "hunt": {
      const quarry = nearestPrey(game, self, config);
      if (quarry === null) return [];
      const watched = watcher(game, self, config);
      // A cell any part of which is watched, its middle or near any corner, is kept out of, so
      // a body heading through the cells left never steps into view. The last cell or so up to
      // its quarry it takes whatever way, to reach it at all.
      const inset = map.cell * 0.45;
      const avoid = avoidingWhere(
        map,
        (at) =>
          Math.hypot(at.x - quarry.x, at.y - quarry.y) > map.cell * 1.5 &&
          CORNERS.some(([dx, dy]) =>
            watched({ x: at.x + dx * inset, y: at.y + dy * inset }),
          ),
      );
      return planRoute(map, self.radius, self, quarry, avoid) ?? [];
    }
    case "retreat":
      return retreatRoute(game, self, state.home ?? self, config);
    case "enraged": {
      const prey =
        livingBody(game, state.foe) ?? nearestPrey(game, self, config);
      if (prey === null) return [];
      return (
        planRoute(map, self.radius, self, prey) ?? [{ x: prey.x, y: prey.y }]
      );
    }
  }
}

/** `state` in `mode` until `until`, planning anew at once, at world time `now`. */
function enter(
  state: StalkerState,
  mode: Mode,
  now: number,
  until: number,
): StalkerState {
  return { ...state, mode, until, route: [], repathAt: now };
}

/**
 * The mode it moves to: hurt, it rages; a rage or retreat run out goes back to the hunt; and a
 * hunt that any body's gaze falls on, its own kind's aside, turns to retreat.
 */
function think(
  state: StalkerState,
  self: WorldEntity,
  game: Session,
  config: StalkerConfig,
): StalkerState {
  const now = game.worldTime;
  const hurt = hurtSinceLastStep(game, self.id);
  if (hurt !== null) {
    const foe = avenged(game, self, hurt.by, config);
    return enter(
      { ...state, foe },
      "enraged",
      now,
      now + config.enragedSeconds,
    );
  }
  if (state.mode !== "hunt" && now >= state.until)
    return enter(state, "hunt", now, now);
  if (state.mode === "hunt" && watcher(game, self, config)(self))
    return enter(state, "retreat", now, now + config.retreatSeconds);
  return state;
}

/** `state` with its route replanned, when due. */
function replan(
  state: StalkerState,
  self: WorldEntity,
  game: Session,
  config: StalkerConfig,
): StalkerState {
  const now = game.worldTime;
  if (now < state.repathAt) return state;
  return {
    ...state,
    route: plan(game, self, state, config),
    repathAt: now + config.repathInterval,
  };
}

interface Sounds {
  readonly retreat: Sound;
  readonly enraged: Sound;
  readonly attack: Sound;
}

/**
 * Sounds, as the host, on every client, what a step from `previous` to `next` did: a retreat or a
 * rage begun, or a strike.
 */
function cue(
  self: WorldEntity,
  previous: StalkerState,
  next: StalkerState,
  game: Session,
  sounds: Sounds,
): void {
  const entered = previous.mode !== next.mode || previous.until !== next.until;
  const made = [
    entered && next.mode === "retreat" && sounds.retreat,
    entered && next.mode === "enraged" && sounds.enraged,
    next.attacking && sounds.attack,
  ];
  for (const sound of made)
    if (sound !== false)
      effect(game, { at: { x: self.x, y: self.y }, sound }, self);
}

function definition(config: StalkerConfig): EntityDefinition<StalkerState> {
  const sounds: Sounds = {
    retreat: sound({ url: retreatUrl, range: config.sounds.retreat }),
    enraged: sound({ url: enragedUrl, range: config.sounds.enraged }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    data: StalkerState,
    // It needs no eyes to know where bodies are, but it has them: it sees as a player does,
    // down its facing.
    eyes: (_entity, state, game) => {
      const { coneAngle, lookRange, surroundingsRadius } = game.config.vision;
      return {
        cone: { direction: state.facing, angle: coneAngle, range: lookRange },
        around: surroundingsRadius,
      };
    },
    update(entity, state, dt, game) {
      const settled =
        state.home === null
          ? { ...state, home: { x: entity.x, y: entity.y } }
          : state;
      const thought = replan(
        think(settled, entity, game, config),
        entity,
        game,
        config,
      );
      const next = strikeIf(
        thought,
        game.worldTime,
        touching(game, entity, config.ignores).length > 0,
        config.attackCooldown,
      );
      cue(entity, state, next, game, sounds);
      return walk(entity, next, config.speed, dt);
    },
    strikes(entity, state, game): Strike[] {
      // A blow on whatever it touches, the step it strikes.
      const struck = state.attacking
        ? touching(game, entity, config.ignores)
        : [];
      return strikeEach(struck, config.damage);
    },
    draw(ctx, entity, state, now) {
      ctx.save();
      // Raging, it shakes; hunting, it is hard to make out.
      const shake = state.mode === "enraged" ? Math.sin(now / 25) * 1.5 : 0;
      const at = { x: entity.x + shake, y: entity.y };
      ctx.globalAlpha = state.mode === "hunt" ? 0.7 : 1;
      drawEmoji(ctx, at, GLYPH, entity.radius * 2);
      drawRing(
        ctx,
        { ...at, radius: entity.radius },
        COLOURS[state.mode],
        2,
        0,
      );
      drawFacing(ctx, at, state.facing, entity.radius * 1.5);
      ctx.restore();
    },
  };
}

/**
 * The stalker: alone, arriving in the dark out of every player's sight. It knows
 * where every body is and which way each faces, and creeps up on the nearest along a way no
 * body looks down, faster than a walk. Caught in any body's gaze, it hisses and backs off to
 * where it arrived, keeping well away, for a long while. Hurt, it shrieks and runs at whatever
 * lives nearest, for a short while. Whatever it touches takes a killing blow. Light means nothing
 * to it once it is about; a stun holds it like anything else.
 */
export const stalker = defineEntity(NAME, (config: StalkerConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) => freshStalker(game.worldTime),
  }),
}));
