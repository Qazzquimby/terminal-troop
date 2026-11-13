import {
  circleAhead,
  defineItem,
  effect,
  entitiesIn,
  hurt,
  playersIn,
  push,
  sound,
} from "../../sim/index.js";
import type { ItemUse } from "../../sim/index.js";
import hitUrl from "./sfx/hit.mp3";
import missUrl from "./sfx/miss.mp3";

/** How the shovel attacks. Distances in pixels, times in sim seconds. */
export interface ShovelConfig {
  /** The radius of the hitbox. */
  readonly radius: number;
  /** How far in front of the player the hitbox is centred. */
  readonly reach: number;
  /** Damage dealt to every world entity and other player in the hitbox. */
  readonly damage: number;
  /** How far, in pixels, a hit entity or player is pushed away from the swinger. */
  readonly knockback: number;
  /** Minimum time between swings. */
  readonly cooldown: number;
  /** How long a swing is shown. */
  readonly duration: number;
  /** Volume of a swing's sound, 0..1. */
  readonly volume: number;
  /** How far, in pixels, the noise of a swing that hits carries. */
  readonly hitNoiseRadius: number;
}

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
 * A swing hurts every world entity and other player in front of the swinger and knocks each away
 * from it; every client hears it, from the swinger, and sees it land. One that hits makes a noise.
 */
export const shovel = defineItem("shovel", (config: ShovelConfig) => {
  const sounds = {
    hit: sound({ url: hitUrl, volume: config.volume }),
    miss: sound({ url: missUrl, volume: config.volume }),
  };
  return {
    name: "Shovel",
    emoji: "🪏",
    startingSlot: 0,
    use: {
      cooldown: config.cooldown,
      apply(game, swinger, { x, y, aim }) {
        const at = { x, y };
        const area = circleAhead(at, aim, config.reach, config.radius);
        const struck = [
          ...entitiesIn(game, area),
          ...playersIn(game, area, swinger.id),
        ];
        for (const body of struck) {
          hurt(game, body, config.damage);
          push(game, body, at, config.knockback, "stay");
        }
        const hit = struck.length > 0;
        effect(game, { at, sound: hit ? sounds.hit : sounds.miss });
        effect(game, {
          at: area.center,
          use: { item: "shovel", hit },
          ...(hit && { noise: config.hitNoiseRadius }),
        });
      },
    },
    draw(ctx, use, time) {
      drawHitbox(ctx, use, config.radius, config.duration, time);
    },
  };
});
