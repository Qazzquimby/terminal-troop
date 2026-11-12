import {
  applyDamage,
  broadcastNoise,
  circleAhead,
  defineItem,
  entitiesIn,
  hurtPlayer,
  knockBack,
  playersIn,
} from "../../sim/index.js";
import type { Circle, ItemUse, Point, Session } from "../../sim/index.js";
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
  /** Whether `area` touches anything a swing by player `by` hits. */
  const hits = (game: Session, area: Circle, by: string): boolean =>
    entitiesIn(game, area).length + playersIn(game, area, by).length > 0;
  return {
    name: "Shovel",
    emoji: "🪏",
    startingSlot: 0,
    cooldown: config.cooldown,
    apply(game, at, aim, by) {
      const area = hitbox(at, aim);
      const { center } = area;
      const hit = hits(game, area, by);
      for (const entity of entitiesIn(game, area)) {
        applyDamage(entity, config.damage);
        knockBack(entity, at, config.knockback, game.world.map, "stay");
      }
      for (const player of playersIn(game, area, by))
        hurtPlayer(game, player, config.damage, {
          from: at,
          distance: config.knockback,
        });
      if (hit)
        broadcastNoise(game, { at: center, radius: config.hitNoiseRadius });
    },
    show(game, at, aim, by) {
      const area = hitbox(at, aim);
      const hit = hits(game, area, by);
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
