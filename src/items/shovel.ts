import { applyDamage, isAreaFree } from "../sim/index.js";
import type {
  Entity,
  ItemBehaviour,
  ItemDefinition,
  ItemUse,
  Point,
  Session,
  TileMap,
} from "../sim/index.js";
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
  /** How far, in pixels, a hit entity is pushed away from the hitbox centre. */
  readonly knockback: number;
  /** Minimum time between swings. */
  readonly cooldown: number;
  /** How long a swing is shown. */
  readonly duration: number;
  /** Volume of a swing's sound, 0..1. */
  readonly volume: number;
}

export const SHOVEL = {
  id: "shovel",
  name: "Shovel",
  maxStack: 1,
  emoji: "🪏",
} as const satisfies ItemDefinition;

const SOUNDS = { hit: hitUrl, miss: missUrl } as const;

/** Pushes `entity` `distance` pixels away from `from`, unless a wall is in the way. */
function knockBack(
  entity: Entity,
  from: Point,
  distance: number,
  map: TileMap,
): void {
  const dx = entity.x - from.x;
  const dy = entity.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const x = entity.x + (dx / length) * distance;
  const y = entity.y + (dy / length) * distance;
  if (isAreaFree(map, x, y, entity.radius)) {
    entity.x = x;
    entity.y = y;
  }
}

/** Every world entity in the hitbox. */
function targets(game: Session, center: Point, radius: number): Entity[] {
  return [...game.entities.values()].filter(
    (entity) =>
      Math.hypot(entity.x - center.x, entity.y - center.y) <=
      radius + entity.radius,
  );
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

/** The shovel: a short melee attack in front of the player. */
export function createShovel(config: ShovelConfig): ItemBehaviour {
  const hitbox = (at: Point, aim: number): Point => ({
    x: at.x + Math.cos(aim) * config.reach,
    y: at.y + Math.sin(aim) * config.reach,
  });
  return {
    cooldown: config.cooldown,
    apply(game, at, aim) {
      const center = hitbox(at, aim);
      for (const entity of targets(game, center, config.radius)) {
        applyDamage(entity, config.damage);
        knockBack(entity, center, config.knockback, game.world.map);
      }
    },
    show(game, at, aim) {
      const center = hitbox(at, aim);
      const hit = targets(game, center, config.radius).length > 0;
      void game.sfx.play(hit ? SOUNDS.hit : SOUNDS.miss, at, game.local, {
        volume: config.volume,
      });
      return { center, hit };
    },
    draw(ctx, use, time) {
      drawHitbox(ctx, use, config.radius, config.duration, time);
    },
  };
}
