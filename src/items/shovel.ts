import { applyDamage, cullDeadEntities } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";
import type { ItemBehaviour } from "./behaviour.js";
import hitUrl from "../assets/sfx/shovel/hit.mp3";
import missUrl from "../assets/sfx/shovel/miss.mp3";

/** How the shovel attacks. Distances in pixels, times in milliseconds. */
export interface ShovelConfig {
  /** The radius of the hitbox. */
  readonly radius: number;
  /** How far in front of the player the hitbox is centred. */
  readonly reach: number;
  /** Damage dealt to every world entity in the hitbox. */
  readonly damage: number;
  /** Minimum time between swings. */
  readonly cooldownMs: number;
  /** How long a swing is shown. */
  readonly durationMs: number;
}

const SOUNDS = { hit: hitUrl, miss: missUrl } as const;

/** Damages every world entity in the hitbox; returns whether anything was hit. */
function damageTargets(
  game: Session,
  center: Point,
  radius: number,
  damage: number,
): boolean {
  let hit = false;
  for (const entity of game.entities.values()) {
    if (
      Math.hypot(entity.x - center.x, entity.y - center.y) <=
      radius + entity.radius
    ) {
      applyDamage(entity, damage);
      hit = true;
    }
  }
  if (hit) cullDeadEntities(game);
  return hit;
}

/** A hitbox that fades out over its duration; green when it connected. */
function drawHitbox(
  ctx: CanvasRenderingContext2D,
  center: Point,
  radius: number,
  hit: boolean,
  startedAt: number,
  endsAt: number,
  now: number,
): void {
  const progress = (now - startedAt) / (endsAt - startedAt);
  if (progress < 0 || progress > 1) return;

  const color = hit ? "#8fd694" : "#e1bd83";
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

/** The shovel: a short melee attack in front of the player. */
export function createShovel(config: ShovelConfig): ItemBehaviour {
  return {
    cooldownMs: config.cooldownMs,
    use(game, now) {
      const { local } = game;
      const center = {
        x: local.x + Math.cos(local.aim) * config.reach,
        y: local.y + Math.sin(local.aim) * config.reach,
      };
      const hit = damageTargets(game, center, config.radius, config.damage);
      const endsAt = now + config.durationMs;
      void game.sfx
        .play(hit ? SOUNDS.hit : SOUNDS.miss, local, local, { volume: 0.8 });
      return {
        startedAt: now,
        endsAt,
        draw(ctx, drawNow) {
          drawHitbox(ctx, center, config.radius, hit, now, endsAt, drawNow);
        },
      };
    },
  };
}
