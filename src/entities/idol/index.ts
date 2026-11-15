import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  defineEntity,
  effect,
  hasKindTag,
  isAreaFree,
  livingBody,
  isLookedAt,
  isLit,
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
import { drawRing, nearestSeenBody, touching } from "../bodies.js";
import { Route, strikeEach, strikeIf, Time, Waypoint } from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { avoidingLight, planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const stepUrl = new URL("./sfx/step.mp3", import.meta.url).href;
const strikeUrl = new URL("./sfx/strike.mp3", import.meta.url).href;

/**
 * The idol: a stone figure that walks its round in the dark and hunts any body it sees, but cannot
 * move while anyone looks at it. Distances in pixels, times in sim seconds; it moves at a player's
 * sprint.
 */
export interface IdolConfig extends Hunting {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  /** How far it sees, all round it, along a clear line. */
  readonly sightRange: number;
  /** Its round: back and forth between where it arrived and a point about this far off. */
  readonly patrol: {
    /** How far the far end lies from where it arrived, as the crow flies. */
    readonly distance: number;
    /** How far that may vary either way. */
    readonly spread: number;
    /** Points tried for the far end in a step before trying again later. */
    readonly tries: number;
    /** Seconds before trying again after no leg of its round could be planned. */
    readonly retry: number;
  };
  /** Seconds of moving, time it stands looked at aside, that a hunt lasts. */
  readonly huntSeconds: number;
  /** Seconds between plans of its route to its quarry. */
  readonly repathInterval: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  readonly attackCooldown: number;
  /** Its stone tread: a step this often while it moves, heard and making noise out to `range`. */
  readonly step: { readonly interval: number; readonly range: number };
  /** How far its strike is heard. */
  readonly strikeRange: number;
}

/**
 * What it is doing, and whether it stands frozen under someone's eyes, which everyone reads, to
 * draw it:
 * - patrol: walks between `home` and `far`, along routes kept off lit ground
 * - hunt: goes straight for `quarry`, wherever they are, until `huntUntil`, which is pushed back
 *   for as long as it stands looked at
 * Only the host reads the rest, and sends it so that whoever hosts next goes on from it.
 */
export const IdolState = z.object({
  mode: z.enum(["patrol", "hunt"]),
  frozen: z.boolean(),
  /** Where its round starts: where it arrived, null until its first step. */
  home: Waypoint.nullable(),
  far: Waypoint.nullable(),
  route: Route,
  quarry: z.string().nullable(),
  huntUntil: Time,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  stepAt: Time,
});

export type IdolState = z.output<typeof IdolState>;

const NAME = "idol";

const IDOL_GLYPH = "🗿";

const COLOURS = {
  patrol: "#8c8577",
  hunt: "#c0392b",
  frozen: "#e8e2d0",
} as const;

/** A fresh idol's state at world time `now`; its round starts where it first steps. */
export function freshIdol(now: number): IdolState {
  return {
    mode: "patrol",
    frozen: false,
    home: null,
    far: null,
    route: [],
    quarry: null,
    huntUntil: now,
    repathAt: now,
    attackAt: now,
    attacking: false,
    stepAt: now,
  };
}

/** The speed it moves at: a player's sprint. */
function runSpeed(game: Session): number {
  const { player } = game.config;
  return player.speed * player.sprintMultiplier;
}

/**
 * The far end of its round, and the route there from `self`, kept off lit ground the whole way:
 * a dark point about the patrol distance from home. Null when none of the tries finds one.
 */
function farEnd(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
): { far: Point; route: Point[] } | null {
  const { map } = game.world;
  const { distance, spread, tries } = config.patrol;
  const home = state.home ?? self;
  const avoid = avoidingLight(game);
  for (let attempt = 0; attempt < tries; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const reach = distance + spread * (Math.random() * 2 - 1);
    const far = {
      x: home.x + Math.cos(angle) * reach,
      y: home.y + Math.sin(angle) * reach,
    };
    if (!isAreaFree(map, far.x, far.y, self.radius) || isLit(game, far))
      continue;
    const route = planRoute(map, self.radius, self, far, avoid);
    if (route !== null && route.length > 0) return { far, route };
  }
  return null;
}

/**
 * Its next leg: to whichever end of its round is further, kept off lit ground where it can be,
 * straight through it where it cannot, as when a hunt left it in the light.
 */
function nextLeg(
  state: IdolState,
  self: WorldEntity,
  far: Point,
  game: Session,
): Point[] | null {
  const home = state.home ?? self;
  const to =
    Math.hypot(far.x - self.x, far.y - self.y) >
    Math.hypot(home.x - self.x, home.y - self.y)
      ? far
      : home;
  const { map } = game.world;
  return (
    planRoute(map, self.radius, self, to, avoidingLight(game)) ??
    planRoute(map, self.radius, self, to)
  );
}

/** Walks its round, picking the far end first if it has none. */
function patrol(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
): IdolState {
  const now = game.worldTime;
  if (state.route.length > 0 || now < state.repathAt) return state;
  const retry = { ...state, repathAt: now + config.patrol.retry };
  if (state.far === null) {
    const found = farEnd(state, self, game, config);
    return found === null ? retry : { ...state, ...found };
  }
  const route = nextLeg(state, self, state.far, game);
  return route === null || route.length === 0 ? retry : { ...state, route };
}

/** Back to its round, from wherever the hunt left it. */
function giveUp(state: IdolState, game: Session): IdolState {
  return {
    ...state,
    mode: "patrol",
    quarry: null,
    route: [],
    repathAt: game.worldTime,
  };
}

/**
 * Hunts its quarry: always knows where they are and goes straight for them, round the walls,
 * planning anew now and then; or, with no route short enough, straight at them.
 */
function hunt(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
): IdolState {
  const now = game.worldTime;
  const quarry = livingBody(game, state.quarry);
  if (quarry === null || now >= state.huntUntil) return giveUp(state, game);
  if (now < state.repathAt) return state;
  const route = planRoute(game.world.map, self.radius, self, quarry) ?? [
    { x: quarry.x, y: quarry.y },
  ];
  return { ...state, route, repathAt: now + config.repathInterval };
}

/** The state it moves to: a body it sees on its round, player or monster, starts a hunt. */
function think(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
): IdolState {
  const now = game.worldTime;
  if (state.mode === "patrol") {
    const seen = nearestSeenBody(game, self, config.ignores);
    if (seen !== null)
      return hunt(
        {
          ...state,
          mode: "hunt",
          quarry: seen.id,
          huntUntil: now + config.huntSeconds,
          repathAt: now,
        },
        self,
        game,
        config,
      );
    return patrol(state, self, game, config);
  }
  return hunt(state, self, game, config);
}

/** Strikes, once the cooldown is over, whatever it touches. */
function attack(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
): IdolState {
  return strikeIf(
    state,
    game.worldTime,
    touching(game, self, config.ignores).length > 0,
    config.attackCooldown,
  );
}

/** Its sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly step: Sound;
  readonly strike: Sound;
}

/**
 * Frozen under someone's eyes: it stands still, strikes nothing and its hunt's clock stops, but it
 * still sees, so a body it catches sight of is hunted the moment no one looks.
 */
function freeze(
  state: IdolState,
  self: WorldEntity,
  dt: number,
  game: Session,
  config: IdolConfig,
): IdolState {
  self.vx = 0;
  self.vy = 0;
  const huntUntil =
    state.mode === "hunt" ? state.huntUntil + dt : state.huntUntil;
  const noticed =
    state.mode === "patrol"
      ? nearestSeenBody(game, self, config.ignores)
      : null;
  const now = game.worldTime;
  return {
    ...state,
    frozen: true,
    attacking: false,
    huntUntil: noticed === null ? huntUntil : now + config.huntSeconds,
    ...(noticed !== null && {
      mode: "hunt" as const,
      quarry: noticed.id,
      repathAt: now,
    }),
    // A step taken as it is let go is heard at once.
    stepAt: Math.min(state.stepAt, now),
  };
}

/** Its stone tread while it moves: a heavy step every so often. */
function tread(
  state: IdolState,
  self: WorldEntity,
  game: Session,
  config: IdolConfig,
  sounds: Sounds,
): IdolState {
  const moving = self.vx !== 0 || self.vy !== 0;
  if (!moving || game.worldTime < state.stepAt) return state;
  effect(game, { at: self, sound: sounds.step, tags: ["footstep"] }, self);
  return { ...state, stepAt: game.worldTime + config.step.interval };
}

function definition(config: IdolConfig): EntityDefinition<IdolState> {
  const sounds: Sounds = {
    step: sound({ url: stepUrl, range: config.step.range }),
    strike: sound({ url: strikeUrl, range: config.strikeRange }),
  };
  return {
    radius: config.radius,
    // It cannot die, whatever it takes.
    maxHealth: Infinity,
    data: IdolState,
    // It sees all round it, but looks at nothing: its eyes never hold another idol.
    eyes: () => ({ cone: null, around: config.sightRange }),
    update(entity, arrived, dt, game) {
      const state =
        arrived.home === null
          ? { ...arrived, home: { x: entity.x, y: entity.y } }
          : arrived;
      const held = isLookedAt(game, entity, {
        except: (body) => hasKindTag(game, body.id, [NAME]),
      });
      if (held) return freeze(state, entity, dt, game, config);
      const next = attack(
        think({ ...state, frozen: false }, entity, game, config),
        entity,
        game,
        config,
      );
      if (next.attacking)
        effect(game, { at: entity, sound: sounds.strike }, entity);
      const route = steer(entity, next.route, runSpeed(game), dt);
      return tread({ ...next, route }, entity, game, config, sounds);
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      return strikeEach(touching(game, entity, config.ignores), config.damage);
    },
    draw(ctx, entity, state) {
      // Held, a pale stone ring stands out on a dark floor, so whoever holds it can tell.
      if (state.frozen) drawRing(ctx, entity, COLOURS.frozen, 3, 1);
      drawEmoji(ctx, entity, IDOL_GLYPH, entity.radius * 2.2);
      if (!state.frozen) drawRing(ctx, entity, COLOURS[state.mode], 2, 0);
    },
  };
}

/**
 * The idol: a stone figure that cannot die. It walks back and forth between where it arrived and a
 * dark point about thirty cells off, never setting foot on lit ground, its tread heard far off.
 * Once it sees a body all round it, a player or a monster it does not ignore, it hunts it for a
 * while: it always knows where it is and goes straight for it at a sprint, and whatever it touches
 * takes a heavy blow. While any living body but another idol looks at it, down its view cone and
 * within its reach, along a clear line, a player or a zombie alike, it cannot move, strike, nor run
 * down its hunt's clock; being near one, within the small circle it sees all round it, does not
 * hold it. It arrives rarely, out of the world's start, the light and every player's sight.
 */
export const idol = defineEntity(NAME, (config: IdolConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) => freshIdol(game.worldTime),
  }),
}));
