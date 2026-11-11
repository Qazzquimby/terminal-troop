import { z } from "zod";
import { defineItem, worldData } from "../../sim/index.js";
import type { Scatter } from "../../sim/index.js";

/** Scrap: lying about the world, worth credit to the team. */
export interface ScrapConfig {
  /** Where a new world lays scrap on the ground, one per spot. */
  readonly scatter: Scatter;
}

/** The team's credit. */
const credit = worldData({
  schema: z.number().min(0),
  initial: 0,
});

/** Scrap: lies about the world from the start. The team's credit is kept with it. */
export const scrap = defineItem("scrap", (config: ScrapConfig) => ({
  name: "Scrap",
  maxStack: 1,
  emoji: "🔩",
  scatter: config.scatter,
  world: credit,
}));
