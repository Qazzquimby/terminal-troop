import { defineItem, effect, fan, shoot, sound } from "../sim/index.js";
import type { Content, ItemTraits, ItemUse } from "../sim/index.js";

/** How a gun fires. Distances in pixels, times in sim seconds. */
export interface GunConfig extends ItemTraits {
  /** Damage each shot deals to the first body in its way, friend or foe. */
  readonly damage: number;
  /** How far each shot carries when nothing stops it. */
  readonly range: number;
  /** Shots fired at once, fanned evenly across `arc`; one when left out. */
  readonly pellets?: number;
  /** How wide, in radians, its shots fan out; straight ahead when left out. */
  readonly arc?: number;
  /** Least time between firings. */
  readonly cooldown: number;
  /** How far, in pixels, a firing is heard, and so how far its noise carries. */
  readonly noiseRadius: number;
  /** Volume of its sounds, 0..1. */
  readonly volume: number;
  /** How long its muzzle flash shows. */
  readonly duration: number;
  /** The radius of its muzzle flash, and of the spark where each shot stops. */
  readonly spark: number;
}

/**
 * What sets one gun apart past its config: its name and glyph, and its sounds, a firing's report
 * and the click as it runs dry, each silent when left out.
 */
interface GunLook {
  readonly name: string;
  readonly emoji: string;
  readonly shotUrl?: string;
  readonly breaksUrl?: string;
}

/** A muzzle flash at `use.center` as of `time`, shrinking and fading over the gun's duration. */
function drawMuzzle(
  ctx: CanvasRenderingContext2D,
  { center, startedAt }: ItemUse,
  time: number,
  { spark, duration }: GunConfig,
): void {
  const progress = (time - startedAt) / duration;
  if (progress < 0 || progress > 1) return;
  ctx.save();
  ctx.globalAlpha = 1 - progress;
  ctx.fillStyle = "#ffe08a";
  ctx.beginPath();
  ctx.arc(center.x, center.y, spark * (1 - progress / 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A gun, registered as the item `id` and configured by the slice under it. Each firing spends a
 * use and shoots its shots the way its holder aims: each stops at the first wall or body in its
 * way, and hurts the body, a fellow player as much as a monster. It is loud, and every client
 * sees its muzzle flash and each shot's tracer.
 */
export function defineGun<N extends string>(
  id: N,
  look: GunLook,
): Content<N, GunConfig> {
  return defineItem(id, (config: GunConfig) => {
    const { volume } = config;
    const report =
      look.shotUrl === undefined
        ? undefined
        : sound({ url: look.shotUrl, volume, range: config.noiseRadius });
    return {
      name: look.name,
      emoji: look.emoji,
      traits: config,
      ...(look.breaksUrl !== undefined && {
        breaks: sound({ url: look.breaksUrl, volume }),
      }),
      use: {
        cooldown: config.cooldown,
        apply(game, shooter, { aim }) {
          const shots = fan(aim, config.arc ?? 0, config.pellets ?? 1).map(
            (each) =>
              shoot(
                game,
                shooter,
                { aim: each, range: config.range, damage: config.damage },
                { spark: config.spark },
              ),
          );
          effect(game, {
            at: {
              x: shooter.x + Math.cos(aim) * shooter.radius,
              y: shooter.y + Math.sin(aim) * shooter.radius,
            },
            ...(report !== undefined && { sound: report }),
            noise: config.noiseRadius,
            use: { item: id, hit: shots.some((shot) => shot.struck !== null) },
          });
        },
      },
      draw(ctx, use, time) {
        drawMuzzle(ctx, use, time, config);
      },
    };
  });
}
