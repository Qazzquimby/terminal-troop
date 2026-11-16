import { z } from "zod";
import {
  defineEntity,
  effect,
  eyesOf,
  hasKindTag,
  inView,
  livingBody,
  rounded,
  shroud,
  shroudLeft,
  SHUNS_LIGHT_TAG,
  sound,
  UNNOTICED_TAG,
} from "../../sim/index.js";
import type {
  Dormancy,
  EntityDefinition,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import { between, Route, Time, walk, wanderLeg } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const humUrl = new URL("./sfx/hum.mp3", import.meta.url).href;
const latchUrl = new URL("./sfx/latch.mp3", import.meta.url).href;
const disperseUrl = new URL("./sfx/disperse.mp3", import.meta.url).href;

/**
 * How a gloom drifts, picks whom it follows and how far its darkness reaches. Distances in
 * pixels, speeds in pixels per second, times in sim seconds.
 */
export interface GloomConfig extends Dormancy {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  readonly speed: number;
  /** How far it sees, all round it, along a clear line. */
  readonly sightRange: number;
  /** How far round it its darkness reaches, along a clear line: no light lights any of it. */
  readonly darkRadius: number;
  /** How close it keeps to whom it follows, centre to centre; within it, it hangs still. */
  readonly followDistance: number;
  /** It keeps following a body it has lost sight of while it is within this. */
  readonly leash: number;
  /** Seconds between its choosing whom to follow, and planning its way to them. */
  readonly repathInterval: number;
  /** Seconds the shroud it lays on whom it follows lasts after it last renews it. */
  readonly shroudSeconds: number;
  /** Furthest a drifting leg heads from where it starts, as the crow flies. */
  readonly wanderRange: number;
  /** Seconds it hangs after a drifting leg, drawn between the two. */
  readonly wanderPause: { readonly min: number; readonly max: number };
  /** How loud its hum plays, 0..1. */
  readonly humVolume: number;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    /** The low hum it gives off wherever it is. */
    readonly hum: number;
    /** The breath as it takes up someone new to follow. */
    readonly latch: number;
    /** The sigh as it is struck apart. */
    readonly disperse: number;
  };
}

/**
 * A gloom's state. Everyone reads `since`, when it arrived, to join its hum that far in, and
 * `followee`, to draw it; only the host reads the rest, and sends it so whoever hosts next goes on
 * from it.
 * - `followee`: the body it follows, null while it drifts
 * - `route`: its way to them, or its drifting leg
 * - `repathAt`: when it next chooses whom to follow and plans its way
 * - `standUntil`: when it next drifts, having none to follow
 */
export const GloomState = z.object({
  followee: z.string().nullable(),
  route: Route,
  repathAt: Time,
  standUntil: Time,
  since: Time,
  facing: rounded(2),
});

export type GloomState = z.output<typeof GloomState>;

const NAME = "gloom";

/** A fresh gloom's state at world time `now`. */
export function freshGloom(now: number): GloomState {
  return {
    followee: null,
    route: [],
    repathAt: now,
    standUntil: now,
    since: now,
    facing: 0,
  };
}

const distance = (a: Point, b: Point): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** How many of each kind live in the world now, by kind number. */
function headcounts(game: Session): Map<number, number> {
  const counts = new Map<number, number>();
  game.entities.forEach((entity) => {
    if (entity.health > 0)
      counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  });
  return counts;
}

/**
 * Whom `self` follows now: of the living bodies of kinds that shun light that it sees, and the one
 * it already follows while that one is within its leash, the one of the kind fewest of which live
 * in the world; of those, the nearest, the one it already follows winning a tie. Null for none.
 */
function chooseFollowee(
  game: Session,
  self: WorldEntity,
  current: string | null,
  config: GloomConfig,
): WorldEntity | null {
  const sight = eyesOf(game, self);
  const counts = headcounts(game);
  let best: { entity: WorldEntity; count: number; far: number } | null = null;
  for (const entity of game.entities.values()) {
    if (entity.id === self.id || livingBody(game, entity.id) === null) continue;
    if (!hasKindTag(game, entity.id, [SHUNS_LIGHT_TAG])) continue;
    const far = distance(entity, self);
    const followed =
      entity.id === current
        ? far <= config.leash
        : inView(game, sight, entity, config.sightRange);
    if (!followed) continue;
    const count = counts.get(entity.kind) ?? 0;
    const better =
      best === null ||
      count < best.count ||
      (count === best.count &&
        (far < best.far || (far === best.far && entity.id === current)));
    if (better) best = { entity, count, far };
  }
  return best?.entity ?? null;
}

/**
 * What it does next: once a repath is due, it chooses whom to follow and plans its way to them;
 * close enough to them, it hangs still. With no one to follow it drifts a leg at a time, hanging a
 * while between them.
 */
function think(
  state: GloomState,
  self: WorldEntity,
  game: Session,
  config: GloomConfig,
): GloomState {
  const now = game.worldTime;
  const { map } = game.world;
  if (now >= state.repathAt) {
    const followee = chooseFollowee(game, self, state.followee, config);
    const repathAt = now + config.repathInterval;
    if (followee !== null) {
      const route =
        distance(self, followee) <= config.followDistance
          ? []
          : (planRoute(map, self.radius, self, followee) ?? [
              { x: followee.x, y: followee.y },
            ]);
      return { ...state, followee: followee.id, route, repathAt };
    }
    state = { ...state, followee: null, repathAt };
  }
  const followee = livingBody(game, state.followee);
  if (followee !== null) {
    return distance(self, followee) <= config.followDistance
      ? { ...state, route: [] }
      : state;
  }
  if (state.route.length > 0 || now < state.standUntil) return state;
  const leg = wanderLeg(
    map,
    self,
    Math.random,
    self.radius,
    config.wanderRange,
  );
  return {
    ...state,
    followee: null,
    route: leg ?? [],
    standUntil: now + between(Math.random, config.wanderPause),
  };
}

/**
 * Keeps whom it follows shrouded, renewing the shroud once half of it has run out, so it is not
 * sent anew every step.
 */
function keepShrouded(
  state: GloomState,
  game: Session,
  config: GloomConfig,
): void {
  const { followee } = state;
  if (followee === null || livingBody(game, followee) === null) return;
  const left = shroudLeft(game, followee) ?? 0;
  if (left < config.shroudSeconds / 2)
    shroud(game, followee, config.shroudSeconds);
}

/** Its sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly latch: Sound;
  readonly disperse: Sound;
}

const GLOOM_CORE = "rgba(8, 4, 16, 0.9)";

function definition(
  config: GloomConfig,
  sounds: Sounds,
): EntityDefinition<GloomState> {
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    // Monsters leave it be, as if it were not there; a player's blow still breaks it.
    tags: [UNNOTICED_TAG],
    data: GloomState,
    darkness: () => config.darkRadius,
    // It sees all round it, but looks down no cone.
    eyes: () => ({ cone: null, around: config.sightRange }),
    plays: (entity, state) => ({
      key: `${NAME}/${entity.id}`,
      url: humUrl,
      since: state.since,
      volume: config.humVolume,
      range: config.sounds.hum,
      loop: true,
    }),
    update(entity, state, dt, game) {
      const next = think(state, entity, game, config);
      if (next.followee !== null && next.followee !== state.followee)
        effect(game, { at: entity, sound: sounds.latch }, entity);
      keepShrouded(next, game, config);
      return walk(entity, next, config.speed, dt);
    },
    dies(entity, _state, game) {
      effect(
        game,
        { at: { x: entity.x, y: entity.y }, sound: sounds.disperse },
        entity,
      );
    },
    // Seldom seen, at the heart of its own darkness: a knot of black smoke, its shroud drawn by
    // the darkness it gives off.
    draw(ctx, entity, _state, now) {
      ctx.fillStyle = GLOOM_CORE;
      for (let puff = 0; puff < 3; puff++) {
        const angle = (now / 1000) * 1.5 + (puff * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(
          entity.x + Math.cos(angle) * entity.radius * 0.4,
          entity.y + Math.sin(angle) * entity.radius * 0.4,
          entity.radius * 0.8,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    },
  };
}

/**
 * The gloom: a knot of living darkness, moving at twice a player's walk, that one blow breaks. It
 * gives off darkness all round it that no light lights, and follows, close behind, the body it
 * sees of the rarest kind that shuns light, the one nearest among kinds as rare: whomever it
 * follows it shrouds, so that one takes the whole world for dark, steering round no light and
 * waking to none. With no one to follow it drifts. Monsters leave it be. It hums low wherever it
 * is, breathes as it takes up someone new and sighs as it is struck apart. It arrives through the
 * spawner, in the dark.
 */
export const gloom = defineEntity(NAME, (config: GloomConfig) => {
  const sounds: Sounds = {
    latch: sound({ url: latchUrl, range: config.sounds.latch }),
    disperse: sound({ url: disperseUrl, range: config.sounds.disperse }),
  };
  return {
    ...definition(config, sounds),
    ...arrivals({
      kind: NAME,
      radius: config.radius,
      config: config.spawning,
      fresh: (_seed: number, game: Session) => freshGloom(game.worldTime),
    }),
  };
});
