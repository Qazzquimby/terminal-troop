import { z } from "zod";
import {
  bodiesIn,
  defineEntity,
  effect,
  hasKindTag,
  INERT_TAG,
  isAreaFree,
  livingBodies,
  rounded,
  sound,
  spawn,
  teleport,
} from "../../sim/index.js";
import type {
  Body,
  Player,
  Point,
  Session,
  Sound,
  WorldEntity,
} from "../../sim/index.js";
import { between } from "../hunt.js";
import {
  Arming,
  arming,
  drawArmingLight,
  placedAhead,
  stepArming,
} from "../placed.js";

// Not yet in the repo: `new URL` leaves a missing file to fail when played, not when built.
const beepUrl = new URL("./sfx/beep.mp3", import.meta.url).href;
const warpUrl = new URL("./sfx/warp.mp3", import.meta.url).href;

/**
 * A teleporter pad lying where a player put it down, aimed the way its placer faced: once charged,
 * whatever steps on it is sent off the way it is aimed. Distances in pixels, times in sim seconds.
 */
export interface TeleporterConfig {
  readonly radius: number;
  /** Seconds from being put down until it has charged. */
  readonly armSeconds: number;
  /** Seconds from sending bodies off until it has charged again. */
  readonly rearmSeconds: number;
  /** How far, along the way it is aimed, a body it sends off may land. */
  readonly distance: { readonly min: number; readonly max: number };
  /** Spots drawn for each body before giving up on sending it this step. */
  readonly tries: number;
  /** The radius of the flash where a body leaves and where it lands. */
  readonly flash: number;
  /** How far, in pixels, each of its sounds is heard, and so how far its noise carries. */
  readonly sounds: { readonly beep: number; readonly warp: number };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/**
 * Whether it has charged, the way it is aimed, in radians, and whether it has sent anything off
 * yet, after which it charges again in its rearming time: everyone reads them, to draw it.
 */
export const TeleporterState = Arming.extend({
  facing: rounded(2),
  used: z.boolean(),
});

type TeleporterState = z.output<typeof TeleporterState>;

const NAME = "teleporter";

const TAU = Math.PI * 2;

const COLOURS = {
  pad: "#1f3440",
  rim: { charging: "#5d6b74", charged: "#3ae0ff" },
  arrow: { charging: "#7b8a93", charged: "#bff6ff" },
} as const;

/**
 * Puts a fresh teleporter down just ahead of `by`, aimed `aim`, which only the host does; the use
 * of a teleporter item calls it, on the host and on its user's own client alike. Returns where it
 * lies.
 */
export function placeTeleporter(game: Session, by: Player, aim: number): Point {
  const at = placedAhead(game, by, aim, NAME);
  const state: TeleporterState = { ...arming(game), facing: aim, used: false };
  spawn(game, NAME, at, state);
  return at;
}

/**
 * Every body standing on the pad that it sends off: players, monsters and items lying about alike,
 * but inert things, such as the cruiser, a trap, a turret, or the pad itself.
 */
const riders = (game: Session, pad: WorldEntity): Body[] =>
  bodiesIn(game, { center: pad, radius: pad.radius }, pad.id).filter(
    (body) => !hasKindTag(game, body.id, [INERT_TAG]),
  );

/** Whether `body` would land clear of every solid body but itself at `at`. */
const clearOfBodies = (game: Session, body: Body, at: Point): boolean =>
  livingBodies(game).every(
    (other) =>
      other.id === body.id ||
      !(game.entities.get(other.id)?.collides ?? true) ||
      Math.hypot(other.x - at.x, other.y - at.y) >= other.radius + body.radius,
  );

/**
 * Where `body` lands, sent off `pad` the way it is aimed: a spot drawn between the nearest and
 * furthest it may go, clear of walls and solid bodies, whatever lies between. Null when none of
 * the spots tried is.
 */
function landing(
  game: Session,
  pad: WorldEntity,
  facing: number,
  body: Body,
  config: TeleporterConfig,
): Point | null {
  for (let attempt = 0; attempt < config.tries; attempt++) {
    const distance = between(Math.random, config.distance);
    const at = {
      x: pad.x + Math.cos(facing) * distance,
      y: pad.y + Math.sin(facing) * distance,
    };
    if (!isAreaFree(game.world.map, at.x, at.y, body.radius)) continue;
    if (clearOfBodies(game, body, at)) return at;
  }
  return null;
}

/** Sends `body` to `to`, with a flash and a warp where it leaves and again where it lands. */
function send(
  game: Session,
  pad: WorldEntity,
  body: Body,
  to: Point,
  warp: { readonly sound: Sound; readonly flash: number },
): void {
  const flash = { radius: warp.flash, hit: false };
  effect(game, { at: { x: body.x, y: body.y }, sound: warp.sound, flash }, pad);
  teleport(game, body, to);
  effect(game, { at: to, sound: warp.sound, flash }, pad);
}

/**
 * A teleporter: charges some seconds after it is put down, aimed the way its placer faced, and
 * beeps once it has. Then every body that stands on it, players, monsters and items alike, is sent
 * the way it is aimed, through walls, to a clear spot a random distance off, with a flash and a
 * warp at both ends; it charges again for some seconds and beeps when ready. A body with nowhere
 * clear to land stays put, and the pad stays charged. Hunters pay it no mind.
 */
export const teleporter = defineEntity(NAME, (config: TeleporterConfig) => {
  const { volume } = config;
  const beep = sound({ url: beepUrl, volume, range: config.sounds.beep });
  const warp = {
    sound: sound({ url: warpUrl, volume, range: config.sounds.warp }),
    flash: config.flash,
  };
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: TeleporterState,
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      if (!state.armed)
        return stepArming(game, entity, state, {
          seconds: state.used ? config.rearmSeconds : config.armSeconds,
          noise: config.sounds.beep,
          sound: beep,
        });
      let sent = false;
      for (const body of riders(game, entity)) {
        const to = landing(game, entity, state.facing, body, config);
        if (to === null) continue;
        send(game, entity, body, to, warp);
        sent = true;
      }
      return sent ? { ...state, ...arming(game), used: true } : state;
    },
    draw(ctx, entity, state, now) {
      drawPad(ctx, entity, state, now);
      drawArmingLight(ctx, entity, state, now);
    },
  };
});

/** The pad: a disc, its rim aglow once charged, with an arrow the way it is aimed. */
function drawPad(
  ctx: CanvasRenderingContext2D,
  pad: WorldEntity,
  state: TeleporterState,
  now: number,
): void {
  const look = state.armed ? "charged" : "charging";
  const pulse = state.armed ? 0.6 + 0.4 * Math.sin((now / 1000) * TAU) : 1;
  ctx.save();
  ctx.fillStyle = COLOURS.pad;
  ctx.strokeStyle = COLOURS.rim[look];
  ctx.lineWidth = 3;
  ctx.globalAlpha = pulse;
  ctx.beginPath();
  ctx.arc(pad.x, pad.y, pad.radius, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.translate(pad.x, pad.y);
  ctx.rotate(state.facing);
  const r = pad.radius;
  ctx.fillStyle = COLOURS.arrow[look];
  ctx.beginPath();
  ctx.moveTo(r * 0.75, 0);
  ctx.lineTo(-r * 0.35, -r * 0.5);
  ctx.lineTo(-r * 0.1, 0);
  ctx.lineTo(-r * 0.35, r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
