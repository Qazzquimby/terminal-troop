import { z } from "zod";
import { drawEmoji, drawFacing } from "../../render/index.js";
import {
  defineEntity,
  distanceToWall,
  hurtSinceLastStep,
  isAreaFree,
  livingBody,
  rounded,
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
import {
  drawRing,
  facingEyes,
  nearestSeenBody,
  playEach,
  touching,
  touchStrikes,
} from "../bodies.js";
import { avenged, strikeIf, Time, Waypoint } from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { planRoute } from "../route.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const thumpUrl = new URL("./sfx/thump.wav", import.meta.url).href;
const slamUrl = new URL("./sfx/slam.mp3", import.meta.url).href;
const attackUrl = new URL("./sfx/attack.mp3", import.meta.url).href;

/**
 * The thumper: runs flat out in straight lines, stopping to turn between them, and makes for any
 * body it sees. Distances in pixels, times in sim seconds.
 */
export interface ThumperConfig extends Hunting, Dormancy {
  /** How the world's spawner brings them. */
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Its running speed, as a share of a player's sprint. */
  readonly sprintShare: number;
  /** Least length of a run; a wall in the way ends it sooner. */
  readonly minRun: number;
  /** Seconds it stands to turn between runs. */
  readonly turnSeconds: number;
  /** How far it sees a body, down its facing or close round it. */
  readonly sightRange: number;
  /** Headings tried, with no body to make for, for a run as long as its least. */
  readonly headingTries: number;
  /** Damage dealt to each body it touches. */
  readonly damage: number;
  /** Seconds between two touches' damage. */
  readonly attackCooldown: number;
  /** Seconds between the thumps of its running feet. */
  readonly thumpInterval: number;
  /** How far each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly thump: number;
    readonly slam: number;
    readonly attack: number;
  };
}

const NAME = "thumper";

const GLYPH = "🦏";

const COLOURS = { run: "#c8642a", turn: "#7a6a5a" } as const;

/**
 * Everyone reads its mode and facing, to draw it; the rest only the host reads.
 * - run: runs straight down `facing` for `left` pixels more, or until a wall stops it
 * - turn: stands until `until`, then turns for its next run
 * `target` is where it last saw a body it makes for, or where whatever hurt it stood, null for
 * none: it runs its way there, run by run, until it gets there.
 */
export const ThumperState = z.object({
  mode: z.enum(["run", "turn"]),
  facing: rounded(2),
  left: rounded(1),
  until: Time,
  target: Waypoint.nullable(),
  thumpAt: Time,
  attackAt: Time,
  attacking: z.boolean(),
  slammed: z.boolean(),
});

export type ThumperState = z.output<typeof ThumperState>;

/** A fresh thumper's state at world time `now`: about to turn for its first run. */
export function freshThumper(now: number): ThumperState {
  return {
    mode: "turn",
    facing: 0,
    left: 0,
    until: now,
    target: null,
    thumpAt: now,
    attackAt: now,
    attacking: false,
    slammed: false,
  };
}

/** Its running speed, in pixels a second. */
function speedOf(game: Session, config: ThumperConfig): number {
  const { speed, sprintMultiplier } = game.config.player;
  return speed * sprintMultiplier * config.sprintShare;
}

/** A unit vector down `angle`. */
const along = (angle: number): Point => ({
  x: Math.cos(angle),
  y: Math.sin(angle),
});

/**
 * A run with no body to make for: of headings tried evenly round, offset at random, one at random
 * with a clear line as long as its least run, else the one with the longest.
 */
function wanderHeading(
  game: Session,
  self: WorldEntity,
  config: ThumperConfig,
): number {
  const { map } = game.world;
  const offset = Math.random() * Math.PI * 2;
  const tried = Array.from({ length: config.headingTries }, (_, index) => {
    const angle = offset + (index / config.headingTries) * Math.PI * 2;
    return {
      angle,
      clear: distanceToWall(map, self, along(angle), config.minRun),
    };
  });
  const long = tried.filter(({ clear }) => clear >= config.minRun);
  if (long.length > 0)
    return long[Math.floor(Math.random() * long.length)]?.angle ?? 0;
  tried.sort((a, b) => b.clear - a.clear);
  return tried[0]?.angle ?? 0;
}

/**
 * Its next run, towards `target` if it has one: down the first leg of its way there, as long as
 * that leg or its least run, whichever is longer, so it overshoots a corner into the wall past
 * it. Within a cell of the target, it has got there, and wanders on.
 */
function nextRun(
  state: ThumperState,
  self: WorldEntity,
  game: Session,
  config: ThumperConfig,
): ThumperState {
  const { map } = game.world;
  const { target } = state;
  const run = { ...state, mode: "run" as const, slammed: false };
  if (target !== null) {
    const route = planRoute(map, self.radius, self, target) ?? [target];
    const to = route[0];
    if (
      to !== undefined &&
      Math.hypot(target.x - self.x, target.y - self.y) > map.cell
    ) {
      const length = Math.hypot(to.x - self.x, to.y - self.y);
      return {
        ...run,
        facing: Math.atan2(to.y - self.y, to.x - self.x),
        left: Math.max(config.minRun, length),
      };
    }
  }
  return {
    ...run,
    target: null,
    facing: wanderHeading(game, self, config),
    left: config.minRun,
  };
}

/** `state` standing to turn, from now. */
function turn(
  state: ThumperState,
  game: Session,
  config: ThumperConfig,
  slammed = false,
): ThumperState {
  return {
    ...state,
    mode: "turn",
    left: 0,
    until: game.worldTime + config.turnSeconds,
    slammed,
  };
}

/**
 * What it makes for: the nearest body it sees, where it stands now, or, hurt, whatever hurt it,
 * where it stands; otherwise where it was making for already.
 */
function aim(
  state: ThumperState,
  self: WorldEntity,
  game: Session,
  config: ThumperConfig,
): ThumperState {
  const hurt = hurtSinceLastStep(game, self.id);
  const foe = livingBody(game, avenged(game, self, hurt?.by ?? null, config));
  const seen = foe ?? nearestSeenBody(game, self, config, config.sightRange);
  if (seen === null) return state;
  return { ...state, target: { x: seen.x, y: seen.y } };
}

/**
 * Runs on down its heading, or turns: once its run is done, or a wall stands where its next step
 * would take it, which it slams into.
 */
function run(
  state: ThumperState,
  self: WorldEntity,
  game: Session,
  dt: number,
  config: ThumperConfig,
): ThumperState {
  const now = game.worldTime;
  if (state.mode === "turn")
    return now < state.until ? state : nextRun(state, self, game, config);
  const step = speedOf(game, config) * dt;
  const heading = along(state.facing);
  const free = isAreaFree(
    game.world.map,
    self.x + heading.x * step,
    self.y + heading.y * step,
    self.radius,
  );
  if (!free) return turn(state, game, config, true);
  const left = state.left - step;
  return left <= 0 ? turn(state, game, config) : { ...state, left };
}

/** Its feet thump while it runs, each `thumpInterval`. */
function thump(
  state: ThumperState,
  game: Session,
  config: ThumperConfig,
): ThumperState {
  const now = game.worldTime;
  if (state.mode !== "run" || now < state.thumpAt) return state;
  return { ...state, thumpAt: now + config.thumpInterval };
}

interface Sounds {
  readonly thump: Sound;
  readonly slam: Sound;
  readonly attack: Sound;
}

/**
 * Sounds, as the host, on every client, what a step from `previous` to `next` did: a footfall, a
 * slam into a wall, or a strike.
 */
function cue(
  self: WorldEntity,
  previous: ThumperState,
  next: ThumperState,
  game: Session,
  sounds: Sounds,
): void {
  playEach(game, self, [
    next.thumpAt !== previous.thumpAt && sounds.thump,
    next.slammed && !previous.slammed && sounds.slam,
    next.attacking && sounds.attack,
  ]);
}

/** Dust kicked up behind it as it runs. */
const DUST = "rgba(160, 140, 110, 0.45)";

function definition(config: ThumperConfig): EntityDefinition<ThumperState> {
  const sounds: Sounds = {
    thump: sound({ url: thumpUrl, range: config.sounds.thump }),
    slam: sound({ url: slamUrl, range: config.sounds.slam }),
    attack: sound({ url: attackUrl, range: config.sounds.attack }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    dormantBeyond: config.dormantBeyond,
    data: ThumperState,
    eyes: (_entity, state, game) =>
      facingEyes(state.facing, game, config.sightRange),
    update(entity, state, dt, game) {
      const moved = run(
        aim(state, entity, game, config),
        entity,
        game,
        dt,
        config,
      );
      const next = thump(
        strikeIf(
          moved,
          game.worldTime,
          touching(game, entity, config.ignores).length > 0,
          config.attackCooldown,
        ),
        game,
        config,
      );
      cue(entity, state, next, game, sounds);
      const speed = next.mode === "run" ? speedOf(game, config) : 0;
      const heading = along(next.facing);
      entity.vx = heading.x * speed;
      entity.vy = heading.y * speed;
      return next;
    },
    strikes(entity, state, game): Strike[] {
      return touchStrikes(
        game,
        entity,
        state.attacking,
        config.ignores,
        config.damage,
      );
    },
    draw(ctx, entity, state, now) {
      const running = state.mode === "run";
      // Running, it bobs with each stride and kicks up dust behind it.
      const bob = running ? Math.abs(Math.sin(now / 60)) * 2 : 0;
      const at = { x: entity.x, y: entity.y - bob };
      if (running) {
        ctx.save();
        ctx.fillStyle = DUST;
        const behind = along(state.facing + Math.PI);
        for (const [back, size] of [
          [1.2, 0.35],
          [1.7, 0.25],
        ] as const) {
          ctx.beginPath();
          ctx.arc(
            entity.x + behind.x * entity.radius * back,
            entity.y + behind.y * entity.radius * back,
            entity.radius * size,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        ctx.restore();
      }
      const body = { ...at, radius: entity.radius };
      drawEmoji(ctx, body, GLYPH, body.radius * 2);
      drawRing(ctx, body, COLOURS[state.mode], 2, 0);
      drawFacing(ctx, body, state.facing, body.radius * 1.5);
    },
  };
}

/**
 * The thumper: runs at more than a player's sprint in straight lines, each at least its least run
 * long unless a wall ends it, slamming into the wall, and stands a moment to turn between them.
 * Any body it sees or that hurts it, player or monster, it makes for, run by run, down the first
 * leg of its way there, overshooting corners. Whatever it touches takes a heavy blow. Its feet
 * thump loud as it runs, a noise every body near enough hears.
 */
export const thumper = defineEntity(NAME, (config: ThumperConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) => freshThumper(game.worldTime),
  }),
}));
