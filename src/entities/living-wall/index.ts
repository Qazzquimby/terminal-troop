import { z } from "zod";
import { drawWallBlock } from "../../render/index.js";
import {
  besideWall,
  defineEntity,
  effect,
  hurtSinceLastStep,
  livingBody,
  looksAt,
  sound,
} from "../../sim/index.js";
import type {
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { nearestPrey, preyFor, touching, watchedAt } from "../bodies.js";
import type { Watching } from "../bodies.js";
import type { Fleeing, Prey } from "../hunt.js";
import {
  avenged,
  fleeRoute,
  Route,
  strikeEach,
  strikeIf,
  Time,
} from "../hunt.js";
import { avoidingWhere, planRoute, steer } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;
const fleeUrl = new URL("./sfx/flee.mp3", import.meta.url).href;
const crumbleUrl = new URL("./sfx/crumble.mp3", import.meta.url).href;

/**
 * How a living wall lurks, creeps and flees. Distances in pixels, speeds in pixels a second, times
 * in sim seconds.
 */
export interface LivingWallConfig extends Watching, Dormancy {
  /** How the world's spawner brings them: always against a wall. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** How hard it is to push, in player masses. */
  readonly mass: number;
  /** How near a body it hunts must come, walls or no walls, before it moves on it. */
  readonly noticeRange: number;
  /** Its creep towards a body it hunts, while no body it heeds looks at it. */
  readonly speed: number;
  /** Its run once hurt. */
  readonly fleeSpeed: number;
  /** Seconds a flight lasts after its last hurt. */
  readonly fleeSeconds: number;
  /** Where it flees to, as `fleeRoute` picks. */
  readonly flee: Fleeing;
  /** Damage dealt to each body it catches from behind. */
  readonly damage: number;
  /** Seconds between two blows. */
  readonly attackCooldown: number;
  /** Seconds between plans of its route. */
  readonly repathInterval: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly attack: number;
    readonly flee: number;
    readonly crumble: number;
  };
}

const NAME = "livingWall";

/**
 * Only the host reads its state; it draws the same, a wall, whatever it does.
 * - lurk: stands, or settles into the middle of its cell, until a body it hunts comes within its
 *   notice; then creeps on it, along the walls, while no body it heeds looks at it
 * - flee: runs from `foe`, or the nearest body it hunts, until `until`
 * `held` is whether a gaze holds it this step.
 */
export const LivingWallState = z.object({
  mode: z.enum(["lurk", "flee"]),
  until: Time,
  route: Route,
  repathAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  held: z.boolean(),
  foe: z.string().nullable(),
});

export type LivingWallState = z.output<typeof LivingWallState>;

/** A fresh living wall's state at world time `now`. */
export function freshLivingWall(now: number): LivingWallState {
  return {
    mode: "lurk",
    until: now,
    route: [],
    repathAt: now,
    attackAt: now,
    attacking: false,
    held: false,
    foe: null,
  };
}

/** The middle of the cell holding `at`. */
function cellMiddle(game: Session, at: Point): Point {
  const { cell } = game.world.map;
  return {
    x: (Math.floor(at.x / cell) + 0.5) * cell,
    y: (Math.floor(at.y / cell) + 0.5) * cell,
  };
}

/**
 * Its way to `quarry` through cells against a wall where it can, the last cell or so up to it
 * aside; by whatever way where it cannot.
 */
function creepRoute(game: Session, self: WorldEntity, quarry: Point): Point[] {
  const { map } = game.world;
  const near = map.cell * 1.5;
  const avoid = avoidingWhere(
    map,
    (at) =>
      !besideWall(map, at) &&
      Math.hypot(at.x - quarry.x, at.y - quarry.y) > near,
  );
  return (
    planRoute(map, self.radius, self, quarry, avoid) ??
    planRoute(map, self.radius, self, quarry) ??
    []
  );
}

/** Hurt, it runs: from what hurt it, for a while, planning its way at once. */
function startle(
  state: LivingWallState,
  self: WorldEntity,
  game: Session,
  by: string | null,
  config: LivingWallConfig,
): LivingWallState {
  const now = game.worldTime;
  return {
    ...state,
    mode: "flee",
    until: now + config.fleeSeconds,
    foe: avenged(game, self, by, config) ?? state.foe,
    route: [],
    repathAt: now,
    attacking: false,
    held: false,
  };
}

/** Runs from its foe, or else the nearest body it hunts, replanning when due or at a leg's end. */
function flee(
  state: LivingWallState,
  self: WorldEntity,
  game: Session,
  config: LivingWallConfig,
): LivingWallState {
  const now = game.worldTime;
  if (state.route.length > 0 && now < state.repathAt) return state;
  const foe = livingBody(game, state.foe);
  const threats: Point[] = foe === null ? preyFor(game, self, config) : [foe];
  return {
    ...state,
    route: fleeRoute(game.world.map, self, threats, config.flee),
    repathAt: now + config.repathInterval,
  };
}

/**
 * Lurking: held still under a gaze it heeds; else creeping on the nearest body it hunts within its
 * notice; else settling into the middle of its cell, so it stands where a wall would.
 */
function lurk(
  state: LivingWallState,
  self: WorldEntity,
  game: Session,
  config: LivingWallConfig,
): LivingWallState {
  const now = game.worldTime;
  if (watchedAt(game, self, config, self)) return { ...state, held: true };
  const quarry = nearestPrey(game, self, config, config.noticeRange);
  if (quarry === null) {
    const middle = cellMiddle(game, self);
    const settled = Math.hypot(middle.x - self.x, middle.y - self.y) < 1;
    return { ...state, held: false, route: settled ? [] : [middle] };
  }
  if (now < state.repathAt && state.route.length > 0)
    return { ...state, held: false };
  return {
    ...state,
    held: false,
    route: creepRoute(game, self, quarry),
    repathAt: now + config.repathInterval,
  };
}

/**
 * The bodies it catches from behind: those it touches, while it moves, that do not look at it.
 * None while a gaze holds it, while it flees, or while it stands with nowhere to go.
 */
function caught(
  state: LivingWallState,
  self: WorldEntity,
  game: Session,
  config: LivingWallConfig,
): Prey[] {
  if (state.mode !== "lurk" || state.held || state.route.length === 0)
    return [];
  return behind(self, game, config);
}

/** The bodies touching it that it may strike and that do not look at it. */
function behind(
  self: WorldEntity,
  game: Session,
  config: LivingWallConfig,
): Prey[] {
  return touching(game, self, config.ignores).filter((prey) => {
    const body = livingBody(game, prey.id);
    return body !== null && !looksAt(game, body, self);
  });
}

interface Sounds {
  readonly attack: Sound;
  readonly flee: Sound;
  readonly crumble: Sound;
}

function definition(
  config: LivingWallConfig,
): EntityDefinition<LivingWallState> {
  const sounds: Sounds = {
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
    flee: sound({ url: fleeUrl, range: config.sounds.flee }),
    crumble: sound({ url: crumbleUrl, range: config.sounds.crumble }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    mass: config.mass,
    // A bar over it would give it away.
    healthBar: false,
    // Wherever it shows, its cell is drawn as a wall, joined to the real walls round it.
    posesAsWall: true,
    data: LivingWallState,
    // It has no eyes: it feels where bodies are, and knows when one looks at it.
    update(entity, state, dt, game) {
      const now = game.worldTime;
      const hurt = hurtSinceLastStep(game, entity.id);
      let next = state;
      if (hurt !== null) {
        next = startle(state, entity, game, hurt.by, config);
        effect(game, { at: entity, sound: sounds.flee }, entity);
      } else if (state.mode === "flee" && now >= state.until)
        next = { ...state, mode: "lurk", route: [], repathAt: now, foe: null };
      next =
        next.mode === "flee"
          ? flee(next, entity, game, config)
          : lurk(next, entity, game, config);
      next = strikeIf(
        next,
        now,
        caught(next, entity, game, config).length > 0,
        config.attackCooldown,
      );
      if (next.attacking)
        effect(game, { at: entity, sound: sounds.attack }, entity);
      if (next.held) {
        entity.vx = 0;
        entity.vy = 0;
        return next;
      }
      const speed = next.mode === "flee" ? config.fleeSpeed : config.speed;
      return { ...next, route: steer(entity, next.route, speed, dt) };
    },
    strikes(entity, state, game): Strike[] {
      if (!state.attacking) return [];
      // A blow decided as it moved lands on whoever is still behind it, though the step brought it
      // to the end of its route.
      return strikeEach(behind(entity, game, config), config.damage);
    },
    dies(entity, _state, game) {
      effect(
        game,
        {
          at: { x: entity.x, y: entity.y },
          sound: sounds.crumble,
          flash: { radius: game.world.map.cell * 0.75, hit: false },
        },
        entity,
      );
    },
    // Drawn as the wall of the cell it stands in, seen from the local player, as walls are.
    draw(ctx, entity, _state, _now, game) {
      drawWallBlock(ctx, game.world.map, entity, game.local);
    },
  };
}

/**
 * The living wall: drawn as a block of wall in whatever cell it stands in, it arrives against a
 * real wall, out of the light and every player's sight, and stands there until a body it hunts,
 * any but its own kind, comes within ten cells. Then it creeps on it at less than a walk, along the
 * walls where it can, and only while no body that sees looks at it: a gaze holds it still as stone.
 * Whatever it touches as it moves that is not facing it takes a heavy blow. Hurt, it grinds off at
 * twice a sprint for a while, then lurks again. It crumbles as it dies.
 */
export const livingWall = defineEntity(NAME, (config: LivingWallConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    rules: { besideWall: true },
    fresh: (_seed: number, game: Session) => freshLivingWall(game.worldTime),
  }),
}));
