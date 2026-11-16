import type { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import {
  bodiesIn,
  defineEntity,
  effect,
  hasKindTag,
  INERT_TAG,
  ITEM_TAG,
  isStunned,
  livingBodies,
  notices,
  removeFromWorld,
  spawn,
  stun,
} from "../../sim/index.js";
import type { Body, Point, Session, WorldEntity } from "../../sim/index.js";
import { Time } from "../hunt.js";
import { Arming, arming, drawArmingLight, stepArming } from "../placed.js";
// Its sounds, once their assets land; importing a missing file breaks the build.
// import beepUrl from "./sfx/beep.mp3";
// import flashUrl from "./sfx/flash.mp3";

/**
 * A stun trap lying where a player put it down: it arms, then goes off when a body steps on it,
 * stunning every body that sees its flash, players and world entities alike. Distances in pixels, times in sim seconds.
 */
export interface StunTrapConfig {
  /** Its size, and so how near a body must step to set it off. */
  readonly radius: number;
  /** The radius its flash is drawn at, as it goes off. */
  readonly flash: number;
  /** Seconds from being put down until it is armed. */
  readonly armSeconds: number;
  /** How far its flash stuns a body that has a clear line to it. */
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

/**
 * When it was put down, whether it has armed, and when it went off, null until it does. Everyone
 * reads them, to draw it and the light of its flash.
 */
export const TrapState = Arming.extend({ firedAt: Time.nullable() });

type TrapState = z.output<typeof TrapState>;

const NAME = "stunTrap";

const TRAP_GLYPH = "🪤";

/**
 * Puts a fresh stun trap down at `at`, which only the host does; the use of a stun trap item
 * calls it, on the host and on its user's own client alike.
 */
export function placeStunTrap(game: Session, at: Point): void {
  const state: TrapState = { ...arming(game), firedAt: null };
  spawn(game, NAME, { x: at.x, y: at.y }, state);
}

/**
 * Whether the trap acts on `body`, a player or a world entity: anything but itself, inert things
 * and items lying about.
 */
const actsOn = (game: Session, trap: WorldEntity, body: Body) =>
  body.id !== trap.id && !hasKindTag(game, body.id, [INERT_TAG, ITEM_TAG]);

/** Whether a living body, a player or a world entity, stands on the trap. */
function steppedOn(game: Session, trap: WorldEntity): boolean {
  return bodiesIn(game, { center: trap, radius: trap.radius }, trap.id).some(
    (body) => actsOn(game, trap, body),
  );
}

/**
 * Stuns every living body, players and world entities alike, whose eyes see the trap, down their
 * cone or all round, within the flash's range. A blind one is spared, and one already stunned sees
 * nothing, so this flash does not reach it.
 */
function flash(game: Session, trap: WorldEntity, config: StunTrapConfig): void {
  for (const body of livingBodies(game, trap.id)) {
    if (!actsOn(game, trap, body) || isStunned(game, body.id)) continue;
    if (!notices(game, body, trap, config.stunRange)) continue;
    stun(game, body.id, config.stunSeconds);
  }
}

/**
 * A stun trap: arms some seconds after it is put down, beeping once it has; then the first body to
 * step on it, a player or a world entity, sets it off, with a flash that stuns every body that
 * sees it within range, players included, and lights a wide circle for a moment, after which the
 * trap is gone. Hunters pay it no mind.
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
      if (!state.armed)
        return stepArming(game, entity, state, {
          seconds: config.armSeconds,
          noise: config.sounds.beep,
          // sound: beep,
        });
      if (!steppedOn(game, entity)) return state;
      effect(
        game,
        {
          at: entity,
          noise: config.sounds.flash,
          flash: { radius: config.flash, hit: false },
          // sound: bang,
        },
        entity,
      );
      flash(game, entity, config);
      return { ...state, firedAt: now };
    },
    draw(ctx, entity, state, now) {
      drawEmoji(ctx, entity, TRAP_GLYPH, entity.radius * 2);
      if (state.firedAt === null) drawArmingLight(ctx, entity, state, now);
    },
  };
});
