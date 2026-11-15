import {
  circleAhead,
  defineItem,
  effect,
  hurt,
  isAreaFree,
  bodiesIn,
  push,
  sound,
} from "../../sim/index.js";
import type { ItemTraits, ItemUse } from "../../sim/index.js";
import hitUrl from "./sfx/hit.mp3";
import missUrl from "./sfx/miss.mp3";
// Its clang on a wall and its breaking, once their assets land; importing a missing file breaks
// the build. Until then a wall hit makes its noise without a sound, and it breaks silently.
// import wallUrl from "./sfx/wall.mp3";
// import breakUrl from "./sfx/break.mp3";

/** How the shovel attacks. Distances in pixels, times in sim seconds. */
export interface ShovelConfig extends ItemTraits {
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
  /** How far, in pixels, a swing that hits is heard, and so how far its noise carries. */
  readonly hitNoiseRadius: number;
  /** How far, in pixels, a swing that misses is heard, and so how far its noise carries. */
  readonly missNoiseRadius: number;
  /**
   * How far, in pixels, a swing that hits only a wall is heard, and so how far its noise carries.
   */
  readonly wallNoiseRadius: number;
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
 * from it; every client hears it, where it lands, and sees it land. Its sound makes a noise as
 * far as it carries, further for a swing that hits. A swing that hits nothing but a wall clangs
 * off it, and makes a noise of its own. It wears out after its uses.
 */
export const shovel = defineItem("shovel", (config: ShovelConfig) => {
  // const wall = sound({
  //   url: wallUrl,
  //   volume: config.volume,
  //   range: config.wallNoiseRadius,
  // });
  const sounds = {
    hit: sound({
      url: hitUrl,
      volume: config.volume,
      range: config.hitNoiseRadius,
    }),
    miss: sound({
      url: missUrl,
      volume: config.volume,
      range: config.missNoiseRadius,
    }),
  };
  return {
    name: "Shovel",
    emoji: "🪏",
    traits: config,
    // breaks: sound({ url: breakUrl, volume: config.volume }),
    startingSlot: 0,
    use: {
      cooldown: config.cooldown,
      apply(game, swinger, { aim }) {
        const at = { x: swinger.x, y: swinger.y };
        const area = circleAhead(at, aim, config.reach, config.radius);
        const struck = bodiesIn(game, area, swinger.id);
        for (const body of struck) {
          hurt(game, body, config.damage, swinger.id);
          push(game, body, at, config.knockback, {
            blocked: "stay",
            by: swinger,
          });
        }
        const hit = struck.length > 0;
        const { center, radius } = area;
        const clang =
          !hit && !isAreaFree(game.world.map, center.x, center.y, radius);
        effect(game, {
          at: center,
          use: { item: "shovel", hit },
          // A clang plays its miss's whoosh until the clang's own sound lands: `sound: wall`.
          sound: hit ? sounds.hit : sounds.miss,
          ...(clang && { noise: config.wallNoiseRadius }),
        });
      },
    },
    draw(ctx, use, time) {
      drawHitbox(ctx, use, config.radius, config.duration, time);
    },
  };
});
