import { z } from "zod";
import {
  arrivalPoint,
  defineEntity,
  dropAll,
  effect,
  INERT_TAG,
  livingBody,
  removeFromWorld,
  sound,
  spawn,
  teleport,
} from "../../sim/index.js";
import type {
  Body,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import { Time } from "../hunt.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const humUrl = new URL("./sfx/hum.mp3", import.meta.url).href;
const zapUrl = new URL("./sfx/zap.mp3", import.meta.url).href;
const fizzleUrl = new URL("./sfx/fizzle.mp3", import.meta.url).href;

/**
 * A recall: the beam that, some seconds after it locks on a body, takes it to whatever sent for
 * it, leaving everything it carried where it stood. The cruiser's teleporter sends one. Distances
 * in pixels, times in sim seconds.
 */
export interface RecallConfig {
  /** Seconds from locking on a body until it takes it. */
  readonly seconds: number;
  /** Furthest from what sent for it that the body lands. */
  readonly spread: number;
  /** The radius of the flash where the body leaves and where it lands. */
  readonly flash: number;
  /**
   * How far, in pixels, each of its sounds is heard, and so how far its noise carries: the hum
   * as it charges, the zap at both ends, the fizzle when it loses its body.
   */
  readonly sounds: {
    readonly hum: number;
    readonly zap: number;
    readonly fizzle: number;
  };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/**
 * The body it is locked on, what sent for it, when it locked on, and whether its hum has sounded
 * yet: everyone reads them, to draw its shimmer and for a cabin to show it busy.
 */
const RecallState = z.object({
  target: z.string().min(1).max(80),
  anchor: z.string().min(1).max(80),
  since: Time,
  hummed: z.boolean(),
});

type RecallState = z.output<typeof RecallState>;

const NAME = "recall";

const TAU = Math.PI * 2;

/** How many shimmering streaks rise round a body being recalled. */
const STREAKS = 7;

const SHIMMER = "#9ff4ff";

/** The state of `entity`, a recall; null for anything else. */
function recallOf(game: Session, entity: WorldEntity): RecallState | null {
  if (entity.kind !== game.kindIds.get(NAME)) return null;
  const parsed = RecallState.safeParse(entity.data);
  return parsed.success ? parsed.data : null;
}

/**
 * The id of the body being recalled to entity `anchor` now, as this client has it; null for
 * none. A vehicle's teleporter asks it, to send for one body at a time.
 */
export function recalling(game: Session, anchor: string): string | null {
  for (const entity of game.entities.values()) {
    const state = recallOf(game, entity);
    if (state?.anchor === anchor) return state.target;
  }
  return null;
}

/**
 * Locks a recall on `target`, to take it to `anchor` once it has charged, which only the host
 * does; a vehicle's teleporter calls it as part of the action that sends for the body.
 */
export function startRecall(
  game: Session,
  anchor: WorldEntity,
  target: Body,
): void {
  const state: RecallState = {
    target: target.id,
    anchor: anchor.id,
    since: game.worldTime,
    hummed: false,
  };
  spawn(game, NAME, { x: target.x, y: target.y }, state);
}

/** The flash a body wide where a recall's zap lands. */
const zapAt = (at: Point, sound: Sound, radius: number) => ({
  at,
  sound,
  flash: { radius, hit: false },
});

/**
 * A recall: locked on a body, it follows it about, humming as it charges, shimmering round it, the
 * hum heard by whatever is near and noise as the body's own. Once charged, everything the body
 * carries drops where it stands, and it is taken to a free spot near whatever sent for it, with a
 * flash and a zap at both ends. Should the body die, become a ghost or get inside a vehicle, or
 * what sent for it be gone, the recall fizzles out. Any body may be recalled; nothing sees,
 * strikes or hears the recall itself.
 */
export const recall = defineEntity(NAME, (config: RecallConfig) => {
  const { volume } = config;
  const hum = sound({ url: humUrl, volume, range: config.sounds.hum });
  const zap = sound({ url: zapUrl, volume, range: config.sounds.zap });
  const fizzle = sound({ url: fizzleUrl, volume, range: config.sounds.fizzle });
  return {
    radius: 8,
    maxHealth: Infinity,
    mass: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: RecallState,
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      const body = livingBody(game, state.target);
      const anchor = game.entities.get(state.anchor);
      if (body === null || anchor === undefined) {
        effect(
          game,
          { at: { x: entity.x, y: entity.y }, sound: fizzle },
          body ?? entity,
        );
        removeFromWorld(game, entity);
        return state;
      }
      entity.x = body.x;
      entity.y = body.y;
      const from = { x: body.x, y: body.y };
      if (!state.hummed) {
        // The body's own noise: what hunts it hears it, as it would the body's steps.
        effect(game, { at: from, sound: hum }, body);
        return { ...state, hummed: true };
      }
      if (game.worldTime < state.since + config.seconds) return state;
      dropAll(game, body.id, from);
      const to = arrivalPoint(
        game.world,
        anchor,
        body.radius,
        config.spread,
        Math.random,
      );
      effect(game, zapAt(from, zap, config.flash), body);
      teleport(game, body, to);
      effect(game, zapAt(to, zap, config.flash), body);
      removeFromWorld(game, entity);
      return state;
    },
    draw(ctx, entity, state, now, game) {
      const body = game.players.get(state.target) ?? null;
      drawShimmer(
        ctx,
        body ?? entity,
        body?.radius ?? 16,
        (game.worldTime - state.since) / config.seconds,
        now,
      );
    },
  };
});

/**
 * The shimmer round a body being recalled, centred on `at`, `radius` wide: streaks of light
 * rising round it and a ring closing in on it, brighter and faster as `progress` goes from 0 to
 * 1, flickering by `now`.
 */
function drawShimmer(
  ctx: CanvasRenderingContext2D,
  at: Point,
  radius: number,
  progress: number,
  now: number,
): void {
  const done = Math.min(1, Math.max(0, progress));
  const seconds = now / 1000;
  ctx.save();
  ctx.strokeStyle = SHIMMER;
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  for (let streak = 0; streak < STREAKS; streak++) {
    const angle = (streak / STREAKS) * TAU + seconds * (1 + done * 3);
    const rise = (seconds * (0.8 + done * 2) + streak / STREAKS) % 1;
    const x = at.x + Math.cos(angle) * radius * 1.2;
    const y = at.y + radius * 1.4 - rise * radius * 2.8;
    ctx.globalAlpha = (0.25 + done * 0.6) * Math.sin(rise * Math.PI);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - radius * 0.6);
    ctx.stroke();
  }
  const flicker = 0.5 + 0.5 * Math.sin(seconds * TAU * (2 + done * 6));
  ctx.globalAlpha = (0.2 + done * 0.5) * flicker;
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius * (2.2 - done * 1.1), 0, TAU);
  ctx.stroke();
  ctx.restore();
}
