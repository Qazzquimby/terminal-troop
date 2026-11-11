import { z } from "zod";
import { drawEmoji } from "../../render/index.js";
import { defineEntity } from "../../sim/index.js";

/** A car that starts beside the player, carrying a wide light. */
export interface CruiserConfig {
  /** How far the cruiser's light reaches, in pixels. */
  readonly lightRadius: number;
  /** How far from the player the cruiser starts, in pixels. */
  readonly offset: number;
}

/** The cruiser's body; its emoji is drawn to that size. */
const BODY_RADIUS = 10;

const CRUISER_GLYPH = "🚗";

/** More health than any fight takes, and still a number snapshots can carry. */
const UNBREAKABLE = Number.MAX_SAFE_INTEGER;

/** A car that starts beside the first host's player, lighting a wide circle round it. */
export const cruiser = defineEntity("cruiser", (config: CruiserConfig) => ({
  radius: BODY_RADIUS,
  maxHealth: UNBREAKABLE,
  collides: false,
  data: z.object({}),
  light: () => ({ range: config.lightRadius }),
  draw(ctx, entity) {
    drawEmoji(ctx, entity, CRUISER_GLYPH, BODY_RADIUS * 2);
  },
  spawn: { at: "host", offset: { x: config.offset, y: 0 }, data: {} },
}));
