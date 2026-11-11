import { z } from "zod";
import { drawEmoji } from "../render/render.js";
import { nearestFreePoint } from "./collision.js";
import { registerEntityType, spawnEntity } from "./entities.js";
import { kindId } from "./kinds.js";
import { isAreaFree } from "./map.js";
import type { Point } from "./map.js";
import type { Session } from "./session.js";

/** A car that starts beside the player, carrying a wide light. */
export interface CruiserConfig {
  /** How far the cruiser's light reaches, in pixels. */
  readonly lightRadius: number;
  /** How far from the player the cruiser starts, in pixels. */
  readonly offset: number;
  /** How close the player must be to the cruiser to cash out scrap, in pixels. */
  readonly cashoutRadius: number;
}

export const CruiserKind = kindId("cruiser");

/** The cruiser's body; its emoji is drawn to that size. */
const BODY_RADIUS = 10;

const CRUISER_GLYPH = "🚗";

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

/** The cruiser of `config`, for a session to register and a new world to start with. */
export function createCruiser(config: CruiserConfig) {
  return {
    /** Registers the cruiser kind with `game`. */
    register(game: Session): void {
      registerEntityType(game, CruiserKind, {
        radius: BODY_RADIUS,
        maxHealth: Infinity,
        collides: false,
        data: CruiserData,
        light: () => ({ range: config.lightRadius }),
        draw(ctx, entity) {
          drawEmoji(ctx, entity, CRUISER_GLYPH, BODY_RADIUS * 2);
        },
      });
    },
    /** Spawns the cruiser a new world starts with, beside the player. */
    populate(game: Session): void {
      spawnCruiser(game, config);
    },
  };
}
