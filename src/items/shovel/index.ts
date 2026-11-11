import {
  applyDamage,
  broadcastNoise,
  circleAhead,
  defineItem,
  entitiesIn,
  knockBack,
} from "../../sim/index.js";
import type { ItemUse, Point } from "../../sim/index.js";
import hitUrl from "./sfx/hit.mp3";
import missUrl from "./sfx/miss.mp3";

/** How the shovel attacks. Distances in pixels, times in sim seconds. */
export interface ShovelConfig {
  /** The radius of the hitbox. */
  readonly radius: number;
  /** How far in front of the player the hitbox is centred. */
  readonly reach: number;
  /** Damage dealt to every world entity in the hitbox. */
  readonly damage: number;
  /** How far, in pixels, a hit entity is pushed away from the player. */
  readonly knockback: number;
  /** Minimum time between swings. */
  readonly cooldown: number;
  /** How long a swing is shown. */
  readonly duration: number;
  /** Volume of a swing's sound, 0..1. */
  readonly volume: number;
  /** How loud a swing that hits is, as a multiple of a listener's hearing range. */
  readonly hitLoudness: number;
}

const SOUNDS = { hit: hitUrl, miss: missUrl } as const;

/** A hitbox that fades out over `duration` seconds from `use.startedAt`; green when it connected. */
function drawHitbox(
  ctx: CanvasRenderingContext2D,
  use: ItemUse,
  radius: number,
  duration: number,
  time: number,
): void {
  const progress = (time - use.startedAt) / duration;
  if (progress < 0 || progress > 1) return;

  const { center } = use;
  const color = use.hit ? "#8fd694" : "#e1bd83";
  const fade = 1 - progress;

  ctx.save();
  ctx.globalAlpha = fade * 0.4;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = fade;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * The shovel: a short melee attack in front of the player, held in the first slot from the start.
 * A swing that hits makes a noise every client hears.
 */
export const shovel = defineItem("shovel", (config: ShovelConfig) => {
  const hitbox = (at: Point, aim: number) =>
    circleAhead(at, aim, config.reach, config.radius);
  return {
    name: "Shovel",
    emoji: "🪏",
    startingSlot: 0,
    cooldown: config.cooldown,
    apply(game, at, aim) {
      const area = hitbox(at, aim);
      const { center } = area;
      const hit = entitiesIn(game, area);
      for (const entity of hit) {
        applyDamage(entity, config.damage);
        knockBack(entity, at, config.knockback, game.world.map, "stay");
      }
      if (hit.length > 0)
        broadcastNoise(game, { at: center, loudness: config.hitLoudness });
    },
    show(game, at, aim) {
      const area = hitbox(at, aim);
      const hit = entitiesIn(game, area).length > 0;
      void game.sfx.play(hit ? SOUNDS.hit : SOUNDS.miss, at, game.local, {
        volume: config.volume,
      });
      return { center: area.center, hit };
    },
    draw(ctx, use, time) {
      drawHitbox(ctx, use, config.radius, config.duration, time);
    },
  };
});
