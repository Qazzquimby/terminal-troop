import { z } from "zod";
import {
  bodyById,
  defineEntity,
  effect,
  hasKindTag,
  hurtSinceLastStep,
  lookersAt,
  sound,
} from "../../sim/index.js";
import type {
  EntityDefinition,
  GazePull,
  Playing,
  Session,
  Sound,
  Strike,
  WorldEntity,
} from "../../sim/index.js";
import { strikeIf, Time } from "../hunt.js";
import type { Hunting } from "../hunt.js";
import { relocate } from "../relocate.js";
import type { RelocateConfig } from "../relocate.js";
import { arrivals } from "../spawning.js";
import type { SpawningConfig } from "../spawning.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const seizeUrl = new URL("./sfx/seize.mp3", import.meta.url).href;
const stareUrl = new URL("./sfx/stare.mp3", import.meta.url).href;
const squelchUrl = new URL("./sfx/squelch.mp3", import.meta.url).href;
const blinkUrl = new URL("./sfx/blink.mp3", import.meta.url).href;

const NAME = "peeper";

/**
 * The peeper: a lone eye that never moves, dragging the gaze of every body it hunts that could
 * see it onto it, and hurting every body it hunts that looks at it. What it hunts is `targets`,
 * sparing `ignores`, as for any hunter: given no `targets`, any body with eyes. Distances in
 * pixels, times in sim seconds.
 */
export interface PeeperConfig extends Hunting {
  readonly spawning: SpawningConfig;
  readonly radius: number;
  readonly maxHealth: number;
  /** Seconds for a gaze it catches to be dragged all the way onto it; 0 snaps it there. */
  readonly pullSeconds: number;
  /** Health each body looking at it loses a second, taken a share every `interval` seconds. */
  readonly stare: {
    readonly damagePerSecond: number;
    readonly interval: number;
  };
  /**
   * With no body it hunts within `range` for `after` seconds, it leaves for somewhere it might
   * have arrived, as the spawner picks it, unseen by any player at either end. Watched, or with
   * nowhere to go, it tries again `retry` seconds on.
   */
  readonly relocate: RelocateConfig;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    /** The sting as a gaze is first caught, while none was. */
    readonly seize: number;
    /** The drone it keeps up while any body looks at it. */
    readonly stare: number;
    /** A wet squelch as it is hurt. */
    readonly squelch: number;
    /** The blink as it leaves one place, and again as it opens at the next. */
    readonly blink: number;
  };
}

/**
 * What it keeps. Everyone reads `held` and `since`, to draw it and play its drone; only the host
 * reads the rest, and sends it so that whoever hosts next goes on from it.
 */
export const PeeperState = z.object({
  /** The ids of the bodies looking at it now, nearest first. */
  held: z.array(z.string()).max(16),
  /** When the bodies looking at it began to, while any do. */
  since: Time,
  /** When it next may hurt the bodies looking at it, and whether it does this step. */
  attackAt: Time,
  attacking: z.boolean(),
  /** When a body it hunts was last within its relocate range. */
  nearAt: Time,
});

export type PeeperState = z.output<typeof PeeperState>;

/** A fresh peeper's state at world time `now`. */
export function freshPeeper(now: number): PeeperState {
  return { held: [], since: now, attackAt: now, attacking: false, nearAt: now };
}

/** Its sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly seize: Sound;
  readonly squelch: Sound;
  readonly blink: Sound;
}

/** Every body looking at `self` that it hunts, nearest first: its `targets`, sparing `ignores`. */
function lookers(
  game: Session,
  self: WorldEntity,
  config: PeeperConfig,
): string[] {
  const { ignores, targets } = config;
  return lookersAt(game, self, {
    except: (body) =>
      hasKindTag(game, body.id, ignores) ||
      (targets !== undefined && !hasKindTag(game, body.id, targets)),
  })
    .sort(
      (a, b) =>
        Math.hypot(a.x - self.x, a.y - self.y) -
        Math.hypot(b.x - self.x, b.y - self.y),
    )
    .slice(0, 16)
    .map((body) => body.id);
}

/**
 * Once it has gone long enough with no body it hunts near, moves `self` to wherever it might have
 * arrived, as the spawner picks it, out of every player's sight, blinking out and open again; see
 * `relocate`.
 */
function wander(
  state: PeeperState,
  self: WorldEntity,
  game: Session,
  config: PeeperConfig,
  sounds: Sounds,
): PeeperState {
  const { nearAt, moved } = relocate(
    game,
    NAME,
    self,
    state.nearAt,
    config,
    config.relocate,
    sounds.blink,
  );
  return moved ? { ...state, held: [], nearAt } : { ...state, nearAt };
}

/** Who looks at it now, and when it next hurts them: the drone starts as the first gaze is caught. */
function stare(
  state: PeeperState,
  self: WorldEntity,
  game: Session,
  config: PeeperConfig,
  sounds: Sounds,
): PeeperState {
  const now = game.worldTime;
  const held = lookers(game, self, config);
  const caught = state.held.length === 0 && held.length > 0;
  if (caught) effect(game, { at: self, sound: sounds.seize }, self);
  if (held.length === 0)
    return { ...state, held, since: now, attackAt: now, attacking: false };
  // A gaze newly caught is first hurt a tick after it is caught, not at once.
  const since = caught ? now : state.since;
  const attackAt = caught ? now + config.stare.interval : state.attackAt;
  return strikeIf(
    { ...state, held, since, attackAt },
    now,
    true,
    config.stare.interval,
  );
}

/** Its eye: white, veined, its pupil turned on the nearest body looking at it. */
function drawEye(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: PeeperState,
  now: number,
  game: Session,
): void {
  const r = entity.radius;
  const staring = state.held.length > 0;
  const quarry = bodyById(game, state.held[0]);
  // Its pupil drifts idly, or locks onto whoever it holds.
  const look =
    quarry === null
      ? { angle: now * 0.7 + Math.sin(now * 1.9) * 2, reach: 0.25 }
      : {
          angle: Math.atan2(quarry.y - entity.y, quarry.x - entity.x),
          reach: 0.35,
        };
  ctx.save();
  if (staring) {
    ctx.shadowColor = "#ff2a2a";
    ctx.shadowBlur = 12 + 6 * Math.sin(now * 8);
  }
  ctx.fillStyle = "#f2ebe0";
  ctx.beginPath();
  ctx.arc(entity.x, entity.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // Veins creeping in from its rim, redder as it stares.
  ctx.strokeStyle = staring ? "#c0392b" : "#c97b7b";
  ctx.lineWidth = 1;
  for (let vein = 0; vein < 6; vein++) {
    const angle = (vein / 6) * Math.PI * 2 + 0.4;
    ctx.beginPath();
    ctx.moveTo(entity.x + Math.cos(angle) * r, entity.y + Math.sin(angle) * r);
    ctx.lineTo(
      entity.x + Math.cos(angle + 0.25) * r * 0.6,
      entity.y + Math.sin(angle + 0.25) * r * 0.6,
    );
    ctx.stroke();
  }
  const px = entity.x + Math.cos(look.angle) * r * look.reach;
  const py = entity.y + Math.sin(look.angle) * r * look.reach;
  ctx.fillStyle = staring ? "#b3001b" : "#6b3fa0";
  ctx.beginPath();
  ctx.arc(px, py, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  // Its pupil narrows to a slit as it holds a gaze.
  ctx.fillStyle = "#050505";
  ctx.beginPath();
  ctx.ellipse(
    px,
    py,
    staring ? r * 0.1 : r * 0.24,
    r * 0.3,
    look.angle,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.strokeStyle = "#2b0d0d";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(entity.x, entity.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** A wavering red thread from it to each body it holds, pulsing as it draws their eyes in. */
function drawThreads(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: PeeperState,
  now: number,
  game: Session,
): void {
  ctx.save();
  for (const id of state.held) {
    const body = bodyById(game, id);
    if (body === null) continue;
    const dx = body.x - entity.x;
    const dy = body.y - entity.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const nx = -dy / length;
    const ny = dx / length;
    ctx.strokeStyle = "#ff2a2a";
    ctx.globalAlpha = 0.25 + 0.2 * Math.sin(now * 10 + length * 0.05);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(entity.x, entity.y);
    const segments = Math.max(4, Math.round(length / 20));
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const wave = Math.sin(t * Math.PI) * 4 * Math.sin(now * 12 - t * 10);
      ctx.lineTo(entity.x + dx * t + nx * wave, entity.y + dy * t + ny * wave);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function definition(config: PeeperConfig): EntityDefinition<PeeperState> {
  const sounds: Sounds = {
    seize: sound({ url: seizeUrl, range: config.sounds.seize }),
    squelch: sound({ url: squelchUrl, range: config.sounds.squelch }),
    blink: sound({ url: blinkUrl, range: config.sounds.blink }),
  };
  // Declared for the noise it makes; played as the drone below, while anyone looks.
  sound({ url: stareUrl, range: config.sounds.stare });
  // It pulls the gazes of the bodies it hunts, and those alone.
  const pull: GazePull = {
    seconds: config.pullSeconds,
    ignores: config.ignores,
    ...(config.targets !== undefined && { targets: config.targets }),
  };
  return {
    radius: config.radius,
    maxHealth: config.maxHealth,
    // It never moves: nothing pushes it.
    mass: Infinity,
    data: PeeperState,
    // It glows faintly: whoever has a clear line to it sees it, light or no light, as they must
    // to be drawn in.
    seenInDark: true,
    pullsGaze: () => pull,
    // Its drone, while any body looks at it, joined from when the first did.
    plays: (_entity, state): Playing | null =>
      state.held.length === 0
        ? null
        : {
            key: "stare",
            url: stareUrl,
            since: state.since,
            range: config.sounds.stare,
            loop: true,
          },
    update(entity, state, _dt, game) {
      if (hurtSinceLastStep(game, entity.id) !== null)
        effect(game, { at: entity, sound: sounds.squelch }, entity);
      const moved = wander(state, entity, game, config, sounds);
      return stare(moved, entity, game, config, sounds);
    },
    strikes(_entity, state): Strike[] {
      if (!state.attacking) return [];
      const { damagePerSecond, interval } = config.stare;
      return state.held.map((target) => ({
        target,
        amount: damagePerSecond * interval,
      }));
    },
    draw(ctx, entity, state, now, game) {
      drawThreads(ctx, entity, state, now, game);
      drawEye(ctx, entity, state, now, game);
    },
  };
}

/**
 * The peeper: a lone eye that never moves. Every body it hunts with a view cone that could see it
 * by turning, it lying within the cone's reach along a clear line, has its facing dragged round
 * onto it, a player's aim as if the mouse were held over it; see gaze-pull.ts. Each body it hunts
 * that looks at it loses health steadily. As configured it hunts players alone, leaving other
 * monsters' gazes, and so their steering, be. With no body it hunts near for a while it blinks
 * out, unseen, and opens somewhere it might have arrived.
 */
export const peeper = defineEntity(NAME, (config: PeeperConfig) => ({
  ...definition(config),
  ...arrivals({
    kind: NAME,
    radius: config.radius,
    config: config.spawning,
    fresh: (_seed: number, game: Session) => freshPeeper(game.worldTime),
  }),
}));
