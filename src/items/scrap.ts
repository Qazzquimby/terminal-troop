import { z } from "zod";
import { drawEmoji } from "../render/render.js";
import { registerEntityType, spawnEntity } from "../sim/entities.js";
import { kindId } from "../sim/kinds.js";
import { randomFreePosition } from "../sim/map.js";
import type { Session } from "../sim/session.js";
import type { ItemDefinition } from "../sim/index.js";
import dropUrl from "./sfx/scrap/drop.mp3";
import cashoutUrl from "./sfx/scrap/cashout.mp3";

export interface ScrapConfig {
  /** Credits a single scrap cashes out for. */
  readonly value: number;
  readonly cashoutVolume: number;
  /** How many scraps a new world starts with. */
  readonly count: number;
}

export const SCRAP = {
  id: "scrap",
  name: "Scrap",
  maxStack: 1,
  emoji: "🔩",
} as const satisfies ItemDefinition;

export const SCRAP_SOUNDS = { cashout: cashoutUrl, drop: dropUrl } as const;

export const ScrapKind = kindId("scrap");

/** The scrap's body; its emoji is drawn to that size. */
const SCRAP_RADIUS = 8;

const ScrapData = z.object({});

function spawnScrap(game: Session, count: number): void {
  for (let index = 0; index < count; index++) {
    const at = randomFreePosition(game.world, SCRAP_RADIUS);
    spawnEntity(game, ScrapKind, at.x, at.y, {});
  }
}

/** Scraps scattered on the ground, for a session to register and a new world to start with. */
export function createScrap(config: ScrapConfig) {
  return {
    /** Registers the scrap kind with `game`. */
    register(game: Session): void {
      registerEntityType(game, ScrapKind, {
        radius: SCRAP_RADIUS,
        maxHealth: Infinity,
        collides: false,
        data: ScrapData,
        draw(ctx, entity) {
          drawEmoji(ctx, entity, SCRAP.emoji, SCRAP_RADIUS * 2);
        },
      });
    },
    /** Spawns the scraps a new world starts with, scattered on the ground. */
    populate(game: Session): void {
      spawnScrap(game, config.count);
    },
  };
}
