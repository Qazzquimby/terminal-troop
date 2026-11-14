import type { ContentConfig, WorldContent } from "../sim/index.js";
import { zombie } from "./zombie/index.js";
import { cruiser } from "./cruiser/index.js";
import { snail } from "./snail/index.js";
import { stunTrap } from "./stun-trap/index.js";
import { lurcher } from "./lurcher/index.js";
import { blister } from "./blister/index.js";
import { witch } from "./witch/index.js";
import { idol } from "./idol/index.js";

export {
  departingIn,
  hasEscaped,
  nearCruiser,
  refuel,
} from "./cruiser/index.js";
export { placeStunTrap } from "./stun-trap/index.js";

/** Every kind of entity in the game; the room numbers kinds by this order. */
const ENTITIES = [
  zombie,
  cruiser,
  stunTrap,
  snail,
  lurcher,
  blister,
  witch,
  idol,
] as const;

/** Each entry's config, under its name. */
export type EntitiesConfig = ContentConfig<(typeof ENTITIES)[number]>;

/** The world's entities, in the order their kinds are numbered. */
export function entityContent(config: EntitiesConfig): WorldContent[] {
  return ENTITIES.map((entry) => entry.create(config));
}
