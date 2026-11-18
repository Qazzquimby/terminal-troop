import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  darkSources,
  defineEntity,
  eyesOf,
  distanceToWall,
  effect,
  emittedLights,
  hurtSinceLastStep,
  isLitTo,
  livingBody,
  rounded,
  sound,
} from "../../sim/index.js";
import type {
  Body,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import {
  ambushSpot,
  between,
  coverRoute,
  foreseenPath,
  inSightOfAny,
  nearest,
  Route,
  strikeEach,
  strikeIf,
  Time,
  walk,
  wanderLeg,
  Waypoint,
  avenged,
} from "../hunt.js";
import type { Ambushing } from "../hunt.js";
import {
  drawRing,
  gazeOn,
  nearestPrey,
  preyFor,
  seenPrey,
  touching,
  watchers,
} from "../bodies.js";
import type { Watching } from "../bodies.js";
import { avoidingWhere, planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const retreatUrl = new URL("./sfx/retreat.mp3", import.meta.url).href;
const enragedUrl = new URL("./sfx/enraged.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/**
 * The stalker: knows where every body is and which way it faces, creeps up on the nearest in the
 * dark out of everyone's sight, ducks out of sight when looked at, and goes wild when hurt.
 * Distances in pixels, times in sim seconds.
 */
export interface StalkerConfig extends Watching {
  /** How the world's spawner brings them. */
  readonly spawning: SpawningConfig;
  /** Whether it opens the closed doors in its way rather than bashing them down. */
  readonly opensDoors?: boolean;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its speed, in pixels a second. */
  readonly speed: number;
  /** Its speed while hunting with a body it hunts in its own sight, in pixels a second. */
  readonly creepSpeed: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /**
   * Least distance a retreat keeps from every body it hunts, where it can, when nowhere it reaches
   * is out of sight.
   */
  readonly retreatDistance: number;
  /** Seconds a retreat lasts before it hunts again. */
  readonly retreatSeconds: number;
  /** Seconds its rage lasts before it hunts again. */
  readonly enragedSeconds: number;
  /** Seconds between plans of its route. */
  readonly repathInterval: number;
  /**
   * How it lies in wait for its quarry: beside the way the quarry is guessed to walk, out of sight
   * of all of it, looking for a better spot every `interval` seconds. Once the quarry has passed
   * and stands within `pounce`, its back to it, it hunts.
   */
  readonly ambush: Ambushing & {
    readonly interval: number;
    readonly pounce: number;
  };
  /**
   * How it wanders with nothing to hunt, once home: legs to spots up to `range` from home, as the
   * crow flies, standing `pause` seconds between them.
   */
  readonly wander: {
    readonly range: number;
    readonly pause: { readonly min: number; readonly max: number };
  };
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly retreat: number;
    readonly enraged: number;
    readonly attack: number;
  };
}

const NAME = "stalker";

const GLYPH = "👤";

/** How faint it is drawn while creeping, and while about otherwise unseen. */
const CREEPING_ALPHA = 0.45;
const LURKING_ALPHA = 0.7;

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
  ambush: "#3a3d4d",
  home: "#4b4f63",
  wander: "#4b4f63",
  retreat: "#7e8bb0",
  enraged: "#e0302a",
} as const;

/**
 * Everyone reads its mode, to draw it, and its facing; the rest only the host reads.
 * - hunt: heads for the nearest body it hunts that stands in the dark, by a way no body watches
 * - ambush: heads for `ambush`, a spot beside the way that body is guessed to walk and hidden from
 *   all of it, by a way no body watches, and waits there for it to pass
 * - home: with none to hunt, heads home by a way no body watches
 * - wander: home, it walks legs round it, standing until `standUntil` between them, null while it
 *   walks one
 * - retreat: gets out of the sight of every body whose gaze it heeds by the quickest way, then
 *   heads home by a way none of them sees, until `until`
 * - enraged: runs straight at `foe`, while it lives, or else the nearest living body, until `until`
 * `home` is where it arrived, null until it first steps; `foe` is the body that last hurt it,
 * which it goes for while enraged. `ambush` is the spot it lies in wait at, kept between its looks
 * for a better one, the next due at `scoutAt`.
 */
export const StalkerState = z.object({
  mode: z.enum(["hunt", "ambush", "home", "wander", "retreat", "enraged"]),
  until: Time,
  home: Waypoint.nullable(),
  route: Route,
  repathAt: Time,
  standUntil: Time.nullable(),
  attackAt: Time,
  attacking: z.boolean(),
  foe: z.string().nullable(),
  ambush: Waypoint.nullable(),
  scoutAt: Time,
  facing: rounded(2),
  creeping: z.boolean(),
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
    standUntil: null,
    attackAt: now,
    attacking: false,
    foe: null,
    ambush: null,
    scoutAt: now,
    facing: 0,
    creeping: false,
  };
}

/**
 * The nearest body it hunts that stands in the dark, as it takes the light: wherever it is lit,
 * by a fixture, the day or a light some body carries, it is passed over. Null for none.
 */
function quarryOf(
  game: Session,
  self: WorldEntity,
  config: StalkerConfig,
): Body | null {
  const lights = emittedLights(game);
  const darks = darkSources(game);
  const dark = preyFor(game, self, config).filter(
    (body) => !isLitTo(game, self.id, body, lights, darks),
  );
  return nearest(self, dark);
}

/** How far `at` is from the nearest of `bodies`; Infinity with none. */
function distanceFrom(bodies: readonly Point[], at: Point): number {
  const body = nearest(at, bodies);
  return body === null ? Infinity : Math.hypot(body.x - at.x, body.y - at.y);
}

/**
 * Its way home keeping at least the retreat distance from every body it hunts, or, while one is
 * already nearer than that, never nearer than it stands now. With no such way, straight away from
 * the nearest as far as the walls let it run. For when nowhere it reaches is out of sight.
 */
function distancingRoute(
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

/**
 * Its retreat: in the sight of any body whose gaze it heeds, as far as the watch range and
 * whichever way they face, the quickest way out of it, round a corner or past where they see to,
 * rather than straight home. Out of it, home by a way none of them sees, or standing where it
 * is hidden when there is none. Where nowhere it reaches is hidden, home keeping its distance.
 */
function retreatRoute(
  game: Session,
  self: WorldEntity,
  home: Point,
  config: StalkerConfig,
): Point[] {
  const { map } = game.world;
  const eyes = watchers(game, self, config);
  const cover = coverRoute(map, self, eyes, config.watchRange);
  if (cover === null) return distancingRoute(game, self, home, config);
  if (cover.length > 0) return cover;
  const seen = avoidingWhere(map, (at) =>
    inSightOfAny(map, eyes, at, self.radius, config.watchRange),
  );
  return planRoute(map, self.radius, self, home, seen) ?? [];
}

/**
 * A way to `to` through no cell any part of which a body whose gaze it heeds watches, its middle
 * or near any corner, so it never steps into view on the way. The last cell or so up to `to` it
 * takes whatever way, to reach it at all. Null for none.
 */
function unwatchedRoute(
  game: Session,
  self: WorldEntity,
  to: Point,
  config: StalkerConfig,
): Point[] | null {
  const { map } = game.world;
  const watched = gazeOn(game, self, config);
  const inset = map.cell * 0.45;
  const avoid = avoidingWhere(
    map,
    (at) =>
      Math.hypot(at.x - to.x, at.y - to.y) > map.cell * 1.5 &&
      CORNERS.some(([dx, dy]) =>
        watched({ x: at.x + dx * inset, y: at.y + dy * inset }),
      ),
  );
  return planRoute(map, self.radius, self, to, avoid);
}

/** Its route for its mode, planned now; wandering plans its own legs. */
function plan(
  game: Session,
  self: WorldEntity,
  state: StalkerState,
  config: StalkerConfig,
): Point[] {
  const { map } = game.world;
  const home = state.home ?? self;
  switch (state.mode) {
    case "hunt": {
      const quarry = quarryOf(game, self, config);
      if (quarry === null) return [];
      return unwatchedRoute(game, self, quarry, config) ?? [];
    }
    case "ambush":
      if (state.ambush === null) return [];
      return (
        unwatchedRoute(game, self, state.ambush, config) ??
        planRoute(map, self.radius, self, state.ambush) ??
        []
      );
    case "home":
      return (
        unwatchedRoute(game, self, home, config) ??
        planRoute(map, self.radius, self, home) ??
        []
      );
    case "wander":
      return state.route;
    case "retreat":
      return retreatRoute(game, self, home, config);
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
  return { ...state, mode, until, route: [], repathAt: now, standUntil: null };
}

/** `state` in `mode`, entered anew only if it is not in it already. */
function settle(state: StalkerState, mode: Mode, now: number): StalkerState {
  return state.mode === mode ? state : enter(state, mode, now, now);
}

/** Whether it stands home: within half a cell of where it arrived. */
function isHome(
  game: Session,
  self: WorldEntity,
  state: StalkerState,
): boolean {
  const home = state.home ?? self;
  return (
    Math.hypot(home.x - self.x, home.y - self.y) <= game.world.map.cell * 0.5
  );
}

/**
 * The mode it moves to: hurt, it rages; a rage or retreat runs its length. Otherwise the gaze of a
 * body it heeds sends it into retreat; a body it hunts in the dark sets it lying in wait or hunting; and with none,
 * it heads home, then wanders there.
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
  const timed = state.mode === "retreat" || state.mode === "enraged";
  if (timed && now < state.until) return state;
  if (gazeOn(game, self, config)(self))
    return enter(state, "retreat", now, now + config.retreatSeconds);
  const quarry = quarryOf(game, self, config);
  if (quarry !== null) return stalk(state, self, quarry, game, config);
  if (state.mode === "wander") return state;
  if (state.mode === "home" && isHome(game, self, state))
    return enter(state, "wander", now, now);
  return settle(state, "home", now);
}

/**
 * Whether it pounces on `quarry`: the quarry within the pounce distance with its back to it, as
 * `facing` has it, or with no facing at all.
 */
function pounces(
  self: Point,
  quarry: Body,
  facing: number | null,
  config: StalkerConfig,
): boolean {
  const dx = self.x - quarry.x;
  const dy = self.y - quarry.y;
  if (Math.hypot(dx, dy) > config.ambush.pounce) return false;
  return facing === null || dx * Math.cos(facing) + dy * Math.sin(facing) <= 0;
}

/**
 * With `quarry` to hunt: every `ambush.interval` it looks for a spot to lie in wait at beside the
 * way the quarry is guessed to walk, keeping the one it has unless a better turns up, and heads
 * there; with none, or once the quarry has passed and stands near with its back to it, it hunts.
 * A quarry with no facing, nothing to guess its way by, it hunts outright.
 */
function stalk(
  state: StalkerState,
  self: WorldEntity,
  quarry: Body,
  game: Session,
  config: StalkerConfig,
): StalkerState {
  const now = game.worldTime;
  const { map } = game.world;
  const facing = eyesOf(game, quarry)?.cone?.direction ?? null;
  let scouted = state;
  if (now >= state.scoutAt) {
    const spot =
      facing === null
        ? null
        : ambushSpot(
            map,
            self.radius,
            foreseenPath(map, quarry, facing, config.ambush),
            config.watchRange,
            config.ambush,
            Math.random,
            state.ambush,
          );
    const ambush = spot === null ? null : Waypoint.parse(spot);
    const moved =
      ambush?.x !== state.ambush?.x || ambush?.y !== state.ambush?.y;
    scouted = {
      ...state,
      ambush,
      scoutAt: now + config.ambush.interval,
      // A new spot, it heads there at once.
      repathAt: moved && state.mode === "ambush" ? now : state.repathAt,
    };
  }
  const lying =
    scouted.ambush !== null && !pounces(self, quarry, facing, config);
  return settle(scouted, lying ? "ambush" : "hunt", now);
}

/** `state` with its route replanned, when due. */
function replan(
  state: StalkerState,
  self: WorldEntity,
  game: Session,
  config: StalkerConfig,
): StalkerState {
  const now = game.worldTime;
  if (state.mode === "wander") return roam(state, self, game, config);
  if (now < state.repathAt) return state;
  return {
    ...state,
    route: plan(game, self, state, config),
    repathAt: now + config.repathInterval,
  };
}

/**
 * Wandering: walks its leg; at its end stands a while, then draws the next, round home. A leg it
 * cannot draw it stands out again.
 */
function roam(
  state: StalkerState,
  self: WorldEntity,
  game: Session,
  config: StalkerConfig,
): StalkerState {
  const now = game.worldTime;
  if (state.route.length > 0) return state;
  const stand = (): number => now + between(Math.random, config.wander.pause);
  if (state.standUntil === null) return { ...state, standUntil: stand() };
  if (now < state.standUntil) return state;
  const leg = wanderLeg(
    game.world.map,
    self,
    Math.random,
    self.radius,
    config.wander.range,
    state.home ?? self,
  );
  if (leg === null) return { ...state, standUntil: stand() };
  return { ...state, route: leg, standUntil: null };
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
    opensDoors: config.opensDoors ?? false,
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
      // Hunting, with a body it would hunt, one in the dark, in its own sight, it creeps.
      const creeping =
        next.mode === "hunt" &&
        seenPrey(game, entity, config).some(
          (body) => !isLitTo(game, entity.id, body),
        );
      cue(entity, state, next, game, sounds);
      return walk(
        entity,
        { ...next, creeping },
        creeping ? config.creepSpeed : config.speed,
        dt,
      );
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
      // Raging, it shakes; hunting, lying in wait, heading home or wandering, it is hard to make
      // out, and creeping or waiting at its spot, harder still.
      const shake = state.mode === "enraged" ? Math.sin(now / 25) * 1.5 : 0;
      const at = { x: entity.x + shake, y: entity.y };
      const lurking =
        state.mode === "hunt" ||
        state.mode === "ambush" ||
        state.mode === "home" ||
        state.mode === "wander";
      // Lying in wait at its spot, it is as faint as creeping.
      const waiting = state.mode === "ambush" && state.route.length === 0;
      ctx.globalAlpha = !lurking
        ? 1
        : state.creeping || waiting
          ? CREEPING_ALPHA
          : LURKING_ALPHA;
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
 * The stalker: alone, arriving in the dark out of every player's sight. It knows where every body
 * is and which way each faces, and comes up on the nearest standing in the dark along a way no
 * body looks down, faster than a walk, slowing to a creep once it has that body in its own sight.
 * Where it can, it gets ahead instead: to a spot beside the way that body would walk in the next
 * few seconds, hidden from all of it, and waits there for the body to pass, then comes on from
 * behind. A body in the light it passes over; with none in the dark it goes home and wanders there.
 * Caught in the gaze of a kind it heeds, players alone as configured, it hisses and gets out of
 * their sight by the quickest way, round a corner or past where they see to, then makes its way
 * home unseen, for a long while. Hurt, it shrieks and runs at whatever lives nearest, for a short
 * while. Whatever it touches takes a killing blow. It walks through light as through dark; a
 * stun holds it like anything else.
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
