import type { ContentConfig, WorldContent } from "../sim/index.js";
import { chaser } from "./chaser/index.js";
import { cruiser } from "./cruiser/index.js";

/** Every kind of entity in the game; the room numbers kinds by this order. */
const CONTENT = [chaser, cruiser] as const;

/** Each entry's config, under its name. */
export type EntitiesConfig = ContentConfig<(typeof CONTENT)[number]>;

/** The world's content, in the order its kinds are numbered. */
export function worldContent(config: EntitiesConfig): WorldContent[] {
  return CONTENT.map((entry) => entry.create(config));
}
