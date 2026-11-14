import type { ContentConfig, WorldContent } from "../sim/index.js";
import { zombie } from "./zombie/index.js";
import { cruiser } from "./cruiser/index.js";

export { departingIn, hasEscaped } from "./cruiser/index.js";

/** Every kind of entity in the game; the room numbers kinds by this order. */
const ENTITIES = [zombie, cruiser] as const;

/** Each entry's config, under its name. */
export type EntitiesConfig = ContentConfig<(typeof ENTITIES)[number]>;

/** The world's entities, in the order their kinds are numbered. */
export function entityContent(config: EntitiesConfig): WorldContent[] {
  return ENTITIES.map((entry) => entry.create(config));
}
