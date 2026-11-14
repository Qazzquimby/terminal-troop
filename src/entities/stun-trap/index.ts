import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  canSeeFrom,
  defineEntity,
  effect,
  hasKindTag,
  INERT_TAG,
  isStunned,
  removeFromWorld,
  rounded,
  spawn,
  stun,
} from "../../sim/index.js";
import type { Point, Session, WorldEntity } from "../../sim/index.js";
// Its sounds, once their assets land; importing a missing file breaks the build.
// import beepUrl from "./sfx/beep.mp3";
// import flashUrl from "./sfx/flash.mp3";

/**
 * A stun trap lying where a player put it down: it arms, then goes off when a world entity steps
 * on it, stunning every entity that sees its flash. Distances in pixels, times in sim seconds.
 */
export interface StunTrapConfig {
  readonly radius: number;
  /** Seconds from being put down until it is armed. */
  readonly armSeconds: number;
  /** How far its flash stuns an entity that has a clear line to it. */
  readonly stunRange: number;
  /** How long its flash stuns for. */
  readonly stunSeconds: number;
  /** The light its flash gives off: how far it reaches, and for how long. */
  readonly light: { readonly range: number; readonly seconds: number };
  /** How far, in pixels, each of its sounds is heard, and so how far its noise carries. */
  readonly sounds: { readonly beep: number; readonly flash: number };
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
}

/** A moment on the world's clock, in sim seconds, sent to a hundredth. */
const Time = rounded(2);

/**
 * When it was put down, whether it has armed, and when it went off, null until it does. Everyone
 * reads them, to draw it and the light of its flash.
 */
export const TrapState = z.object({
  placedAt: Time,
  armed: z.boolean(),
  firedAt: Time.nullable(),
});

type TrapState = z.output<typeof TrapState>;

const NAME = "stunTrap";

const TRAP_GLYPH = "🪤";

/** How wide its flash is drawn, in its own radii. */
const FLASH_SIZE = 6;

/** Seconds between the blinks of its light once armed. */
const BLINK = 1;

const COLOURS = { arming: "#8a8f96", armed: "#ff4a3a" } as const;

/**
 * Puts a fresh stun trap down at `at`, which only the host does; the use of a stun trap item
 * calls it, on the host and on its user's own client alike.
 */
export function placeStunTrap(game: Session, at: Point): void {
  const state: TrapState = {
    placedAt: game.worldTime,
    armed: false,
    firedAt: null,
  };
  spawn(game, NAME, { x: at.x, y: at.y }, state);
}

/** Whether `body` is a world entity the trap acts on: anything but itself and inert things. */
const actsOn = (game: Session, trap: WorldEntity, body: WorldEntity) =>
  body.id !== trap.id && !hasKindTag(game, body.id, [INERT_TAG]);

/** The first world entity standing on the trap, or null; players set it off by no means. */
function steppedOn(game: Session, trap: WorldEntity): WorldEntity | null {
  for (const body of game.entities.values()) {
    if (!actsOn(game, trap, body)) continue;
    if (
      Math.hypot(body.x - trap.x, body.y - trap.y) <=
      trap.radius + body.radius
    )
      return body;
  }
  return null;
}

/**
 * Stuns every world entity within the flash's range with a clear line to the trap; one already
 * stunned sees nothing, so this flash does not reach it.
 */
function flash(game: Session, trap: WorldEntity, config: StunTrapConfig): void {
  const source = { range: config.stunRange };
  for (const body of [...game.entities.values()]) {
    if (!actsOn(game, trap, body) || isStunned(game, body.id)) continue;
    if (!canSeeFrom(game.world.map, { ...source, x: body.x, y: body.y }, trap))
      continue;
    stun(game, body.id, config.stunSeconds);
  }
}

/**
 * A stun trap: arms some seconds after it is put down, beeping once it has; then the first world
 * entity to step on it sets it off, with a flash that stuns every entity that sees it within
 * range and lights a wide circle for a moment, after which the trap is gone. Players neither set
 * it off nor are stunned by it, and hunters pay it no mind.
 */
export const stunTrap = defineEntity(NAME, (config: StunTrapConfig) => {
  // const beep = sound({ url: beepUrl, volume: config.volume, range: config.sounds.beep });
  // const bang = sound({ url: flashUrl, volume: config.volume, range: config.sounds.flash });
  return {
    radius: config.radius,
    maxHealth: Infinity,
    collides: false,
    tags: [INERT_TAG],
    data: TrapState,
    light(_entity, state) {
      return state.firedAt === null ? null : { range: config.light.range };
    },
    update(entity, state, _dt, game) {
      entity.vx = 0;
      entity.vy = 0;
      const now = game.worldTime;
      if (state.firedAt !== null) {
        if (now >= state.firedAt + config.light.seconds)
          removeFromWorld(game, entity);
        return state;
      }
      if (!state.armed) {
        if (now < state.placedAt + config.armSeconds) return state;
        effect(
          game,
          { at: entity, noise: config.sounds.beep /* , sound: beep */ },
          entity,
        );
        return { ...state, armed: true };
      }
      if (steppedOn(game, entity) === null) return state;
      effect(
        game,
        {
          at: entity,
          noise: config.sounds.flash,
          flash: { radius: entity.radius * FLASH_SIZE, hit: false },
          // sound: bang,
        },
        entity,
      );
      flash(game, entity, config);
      return { ...state, firedAt: now };
    },
    draw(ctx, entity, state, now) {
      drawEmoji(ctx, entity, TRAP_GLYPH, entity.radius * 2);
      if (state.firedAt !== null) return;
      const lit = state.armed && now % BLINK < BLINK / 2;
      if (state.armed && !lit) return;
      ctx.fillStyle = state.armed ? COLOURS.armed : COLOURS.arming;
      ctx.beginPath();
      ctx.arc(entity.x, entity.y - entity.radius, 2.5, 0, Math.PI * 2);
      ctx.fill();
    },
  };
});
