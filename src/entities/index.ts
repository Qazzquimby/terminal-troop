import type { ContentConfig, WorldContent } from "../sim/index.js";
import { zombie } from "./zombie/index.js";
import { cruiser } from "./cruiser/index.js";
import { giantSnail, snail } from "./snail/index.js";
import { stunTrap } from "./stun-trap/index.js";
import { blindDog } from "./blind-dog/index.js";
import { exploder } from "./exploder/index.js";
import { sleeper } from "./sleeper/index.js";
import { statue } from "./statue/index.js";
import { stalker } from "./stalker/index.js";
import { hoarder } from "./hoarder/index.js";
import { landMine } from "./land-mine/index.js";
import { mineLayer } from "./mine-layer/index.js";
import { turret } from "./turret/index.js";
import { teleporter } from "./teleporter/index.js";
import { livingWall } from "./living-wall/index.js";
import { gloom } from "./gloom/index.js";
import { recall } from "./recall/index.js";
import { pocketball } from "./pocketball/index.js";
import { ghostGirl } from "./ghost-girl/index.js";
import { doppelganger } from "./doppelganger/index.js";
import { bomb } from "./bomb/index.js";
import { flare } from "./flare/index.js";
import { thumper } from "./thumper/index.js";
import { tricycle } from "./tricycle/index.js";
import { door } from "./door/index.js";
import { balloon, birthdayBoy } from "./birthday-boy/index.js";
import { shrine } from "./shrine/index.js";
import { spawner } from "./spawning.js";

export {
  departingIn,
  hasEscaped,
  shortOfQuota,
  nearCruiser,
  refuel,
  sales,
} from "./cruiser/index.js";
export { placeStunTrap } from "./stun-trap/index.js";
export { placeTurret } from "./turret/index.js";
export { placeTeleporter } from "./teleporter/index.js";
export { placeBomb } from "./bomb/index.js";
export { fireFlare } from "./flare/index.js";
export {
  POCKETBALL_ITEM,
  pocketballGlyph,
  pocketOf,
  throwPocketball,
} from "./pocketball/index.js";

/** Every kind of entity in the game; the room numbers kinds by this order. */
const ENTITIES = [
  zombie,
  cruiser,
  stunTrap,
  snail,
  blindDog,
  exploder,
  sleeper,
  statue,
  stalker,
  hoarder,
  landMine,
  mineLayer,
  turret,
  teleporter,
  giantSnail,
  livingWall,
  gloom,
  recall,
  pocketball,
  ghostGirl,
  doppelganger,
  bomb,
  flare,
  thumper,
  tricycle,
  door,
  birthdayBoy,
  balloon,
  shrine,
  // Registers no kind, so its place in the order numbers none; brings every kind above.
  spawner,
] as const;

/** Each entry's config, under its name. */
export type EntitiesConfig = ContentConfig<(typeof ENTITIES)[number]>;

/** The world's entities, in the order their kinds are numbered. */
export function entityContent(config: EntitiesConfig): WorldContent[] {
  return ENTITIES.map((entry) => entry.create(config));
}
