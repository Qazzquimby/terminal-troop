import { health } from "../sim/index.js";
import type { ContentConfig, WorldContent } from "../sim/index.js";
import { chaser } from "./chaser/index.js";
import { cruiser } from "./cruiser/index.js";

/** Every kind of entity in the game; the room numbers kinds by this order. */
const ENTITIES = [chaser, cruiser] as const;

/** Each entry's config, under its name. */
export type EntitiesConfig = ContentConfig<(typeof ENTITIES)[number]>;

/** The world's entities, in the order their kinds are numbered, and the damage they deal players. */
export function entityContent(config: EntitiesConfig): WorldContent[] {
  return [...ENTITIES.map((entry) => entry.create(config)), health];
}
