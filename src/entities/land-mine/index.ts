import { z } from "zod";
import {
  bodiesIn,
  defineEntity,
  effect,
  hasKindTag,
  hurtSinceLastStep,
  INERT_TAG,
  ITEM_TAG,
  removeFromWorld,
  rounded,
  sound,
  spawn,
} from "../../sim/index.js";
import type { Point, Session, Sound, WorldEntity } from "../../sim/index.js";
import { detonate } from "../blast.js";
import type { Blast } from "../blast.js";

// The files may not be in yet: a missing one plays nothing, but its noise is still made.
const armUrl = new URL("./sfx/beep.wav", import.meta.url).href;
const beepUrl = new URL("./sfx/beep.wav", import.meta.url).href;
const triggerUrl = new URL("./sfx/beep.wav", import.meta.url).href;
const blastUrl = new URL("./sfx/blast.wav", import.meta.url).href;

/**
 * A land mine lying where something laid it: it arms, beeps now and then, and goes off when a body
 * comes near. Distances in pixels, times in sim seconds.
 */
export interface LandMineConfig {
  readonly radius: number;
  /** Seconds from being laid until it is armed. */
  readonly armSeconds: number;
  /** Seconds between its beeps once armed. */
  readonly beepGap: number;
  /** How near a body, its edge to the mine's middle, sets it off once armed. */
  readonly triggerRange: number;
  /** Kind tags of the bodies that never set it off, its own kind as a rule. */
  readonly ignores: readonly string[];
  /** Seconds from being set off to going off. */
  readonly fuse: number;
  /** How far it bursts, and the damage it deals where it lies and at the edge. */
  readonly blast: Blast;
  /** Whether its burst knocks down the walls it reaches. */
  readonly breaksWalls: boolean;
  /** How far, in pixels, each of its sounds is heard, and so how far the noise it makes carries. */
  readonly sounds: {
    readonly arm: number;
    readonly beep: number;
    readonly trigger: number;
    readonly blast: number;
  };
}

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

/**
 * When it was laid, when it next beeps once armed (null until it arms), and when it goes off,
 * null until something sets it off. Everyone reads them, to draw its light.
 */
export const MineState = z.object({
  laidAt: Time,
  beepAt: Time.nullable(),
  burstAt: Time.nullable(),
});

export type MineState = z.output<typeof MineState>;

const NAME = "landMine";

/**
 * Lays a fresh land mine at `at`, which only the host does; a mine layer calls it as it goes, and
 * anything else that lays mines may.
 */
export function layMine(game: Session, at: Point): void {
  const state: MineState = {
    laidAt: game.worldTime,
    beepAt: null,
    burstAt: null,
  };
  spawn(game, NAME, { x: at.x, y: at.y }, state);
}

/** The land mines in the world. */
export function mines(game: Session): WorldEntity[] {
  const kind = game.kindIds.get(NAME);
  return [...game.entities.values()].filter((entity) => entity.kind === kind);
}

/**
 * Whether a living body that sets it off stands within its trigger range: any body, players and
 * world entities alike, the cruiser too, but items lying about and the kinds its config ignores.
 */
function crossed(
  game: Session,
  mine: WorldEntity,
  config: LandMineConfig,
): boolean {
  const ignored = [...config.ignores, ITEM_TAG];
  return bodiesIn(
    game,
    { center: mine, radius: config.triggerRange },
    mine.id,
  ).some((body) => !hasKindTag(game, body.id, ignored));
}

/** Its sounds, each heard, and making noise, out to its range. */
interface Sounds {
  readonly arm: Sound;
  readonly beep: Sound;
  readonly trigger: Sound;
  readonly blast: Sound;
}

/** What a mine does this step, as the host. */
function stepMine(
  entity: WorldEntity,
  state: MineState,
  game: Session,
  config: LandMineConfig,
  sounds: Sounds,
): MineState {
  const now = game.worldTime;
  const cue = (made: Sound) => {
    effect(game, { at: entity, sound: made }, entity);
  };
  if (state.burstAt !== null) {
    if (now < state.burstAt) return state;
    detonate(game, entity, config.blast, {
      sound: sounds.blast,
      walls: config.breaksWalls,
    });
    removeFromWorld(game, entity);
    return state;
  }
  // A hurt, as another mine's burst or a shot, sets it off, armed or not.
  const struck = hurtSinceLastStep(game, entity.id) !== null;
  if (state.beepAt === null && !struck) {
    if (now < state.laidAt + config.armSeconds) return state;
    cue(sounds.arm);
    return { ...state, beepAt: now + config.beepGap };
  }
  if (struck || crossed(game, entity, config)) {
    cue(sounds.trigger);
    return { ...state, burstAt: now + config.fuse };
  }
  if (state.beepAt !== null && now >= state.beepAt) {
    cue(sounds.beep);
    return { ...state, beepAt: now + config.beepGap };
  }
  return state;
}

const LOOK = {
  casing: "#3a3d36",
  rim: "#6b6f62",
  arming: "#8a8f96",
  armed: "#ff3a2a",
} as const;

/** How many times a second its light blinks: armed, and once set off. */
const BLINK = { armed: 1, set: 10 } as const;

/** A squat dark disc, its light grey while it arms, then blinking red, fast once set off. */
function drawMine(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: MineState,
  now: number,
): void {
  const { x, y, radius } = entity;
  ctx.save();
  ctx.fillStyle = LOOK.casing;
  ctx.strokeStyle = LOOK.rim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const armed = state.beepAt !== null;
  const rate = state.burstAt !== null ? BLINK.set : BLINK.armed;
  const lit = !armed || Math.floor((now / 1000) * rate * 2) % 2 === 0;
  if (lit) {
    ctx.fillStyle = armed ? LOOK.armed : LOOK.arming;
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * A land mine: arms some seconds after it is laid, beeping as it does and again every few seconds
 * after; then any body that comes within range, a player or a world entity, the cruiser too, but
 * another mine or the kinds it ignores, sets it off. It beeps sharply and a moment later bursts,
 * hurting every body it reaches, worst nearest, with a bang heard far off. A hurt, as another
 * mine's burst, sets it off too, armed or not. Hunters pay it no mind.
 */
export const landMine = defineEntity(NAME, (config: LandMineConfig) => {
  const sounds: Sounds = {
    arm: sound({ url: armUrl, range: config.sounds.arm }),
    beep: sound({ url: beepUrl, range: config.sounds.beep }),
    trigger: sound({ url: triggerUrl, range: config.sounds.trigger }),
    blast: sound({ url: blastUrl, range: config.sounds.blast }),
  };
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: MineState,
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      return stepMine(entity, state, game, config, sounds);
    },
    draw(ctx, entity, state, now) {
      drawMine(ctx, entity, state, now);
    },
  };
});
