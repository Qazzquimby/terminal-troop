import { z } from "zod";
import { nearestFreePoint } from "./collision.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { isAreaFree } from "./map.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";

/** A light the world starts with beside the player, and how it is placed. */
export interface CruiserConfig {
  readonly lightRadius: number;
  /** How far from the player the beacon starts, in pixels. */
  readonly offset: number;
}

/** Kinds are per-session integers; the chaser takes 1, so the beacon takes 2. */
export const CruiserKind = 2;

/** The beacon's body, independent of how far its light reaches. */
const BODY_RADIUS = 10;

/** How many body radii the drawn glow spreads before fading out. */
const GLOW_REACH = 6;

const CruiserData = z.object({});

function spawnCruiser(game: Session, config: CruiserConfig): void {
  const target: Point = {
    x: game.local.x + config.offset,
    y: game.local.y,
  };
  const at = isAreaFree(game.world.map, target.x, target.y, BODY_RADIUS)
    ? target
    : nearestFreePoint(game.world.map, BODY_RADIUS, target);
  spawnEntity(game, CruiserKind, at.x, at.y, {});
}

/** The beacon of `config`, for a session to register and a new world to start with. */
export function createCruiser(config: CruiserConfig) {
  return {
    /** Registers the beacon kind with `game`. */
    register(game: Session): void {
      registerEntityType(game, CruiserKind, {
        radius: BODY_RADIUS,
        maxHealth: Infinity,
        collides: false,
        data: CruiserData,
        light: () => ({ range: config.lightRadius }),
        draw(ctx, entity, _data, now) {
          const reach =
            BODY_RADIUS * GLOW_REACH * (1 + 0.1 * Math.sin(now / 500));
          const glow = ctx.createRadialGradient(
            entity.x,
            entity.y,
            0,
            entity.x,
            entity.y,
            reach,
          );
          glow.addColorStop(0, "rgba(255, 224, 160, 0.9)");
          glow.addColorStop(1, "rgba(255, 200, 120, 0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(entity.x, entity.y, reach, 0, Math.PI * 2);
          ctx.fill();
        },
      });
    },
    /** Spawns the beacon a new world starts with, beside the player. */
    populate(game: Session): void {
      spawnCruiser(game, config);
    },
  };
}
