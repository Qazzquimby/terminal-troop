import { z } from "zod";
import { effect, isAreaFree } from "../sim/index.js";
import type { Point, Session, Sound, WorldEntity } from "../sim/index.js";
import { Time } from "./hunt.js";

/*
 * What every thing a player puts down shares, such as the stun trap, the turret and the teleporter:
 * it lies where it was put, arms some seconds later, beeping as it does, and shows a light that is
 * steady grey while it arms and blinks once it has. One that goes back to arming after use, as the
 * teleporter does, arms again the same way.
 */

/**
 * When a placed thing began arming, as it was put down or went back to arming, and whether it has
 * armed since: everyone reads it, to draw its light.
 */
export const Arming = z.object({ since: Time, armed: z.boolean() });

export type Arming = z.output<typeof Arming>;

/** A placed thing arming from now. */
export const arming = (game: Session): Arming => ({
  since: game.worldTime,
  armed: false,
});

/**
 * How a placed thing arms: the seconds it takes, and the beep it gives once it has, how far its
 * noise carries and its sound if any.
 */
export interface Arms {
  readonly seconds: number;
  readonly noise: number;
  readonly sound?: Sound;
}

/**
 * `state` armed, as the host steps placed thing `entity`, once it has been arming `arms.seconds`,
 * beeping from it as it arms; `state` as it was before then, or when it has already armed.
 */
export function stepArming<S extends Arming>(
  game: Session,
  entity: WorldEntity,
  state: S,
  arms: Arms,
): S {
  if (state.armed || game.worldTime < state.since + arms.seconds) return state;
  effect(
    game,
    {
      at: { x: entity.x, y: entity.y },
      noise: arms.noise,
      ...(arms.sound !== undefined && { sound: arms.sound }),
    },
    entity,
  );
  return { ...state, armed: true };
}

/** Seconds between the blinks of an armed thing's light. */
const BLINK = 1;

const LIGHT = { arming: "#8a8f96", armed: "#ff4a3a" } as const;

/**
 * The light on a placed thing, atop it: steady grey while it arms, a red blink once it has. `now`
 * is in milliseconds.
 */
export function drawArmingLight(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: Arming,
  now: number,
): void {
  const lit = state.armed && (now / 1000) % BLINK < BLINK / 2;
  if (state.armed && !lit) return;
  ctx.fillStyle = state.armed ? LIGHT.armed : LIGHT.arming;
  ctx.beginPath();
  ctx.arc(entity.x, entity.y - entity.radius, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Where a thing of the kind `kind` that `by` puts down facing `aim` lies: just ahead of `by`,
 * clear of it, so it can be walked onto or stands beside its placer; at `by`'s feet when a wall is
 * there.
 */
export function placedAhead(
  game: Session,
  by: Point & { readonly radius: number },
  aim: number,
  kind: string,
): Point {
  const id = game.kindIds.get(kind);
  const radius = (id === undefined ? null : game.entityTypes.get(id))?.radius;
  if (radius === undefined) return { x: by.x, y: by.y };
  const ahead = by.radius + radius + 2;
  const at = {
    x: by.x + Math.cos(aim) * ahead,
    y: by.y + Math.sin(aim) * ahead,
  };
  return isAreaFree(game.world.map, at.x, at.y, radius)
    ? at
    : { x: by.x, y: by.y };
}
