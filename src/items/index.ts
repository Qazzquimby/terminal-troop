import { lootContent } from "../sim/index.js";
import type { ContentConfig, LootConfig, WorldContent } from "../sim/index.js";
import { flashlight } from "./flashlight/index.js";
import { fuel } from "./fuel/index.js";
import { handgun } from "./handgun/index.js";
import { scrap } from "./scrap/index.js";
import { goldenScrap } from "./golden-scrap/index.js";
import { shotgun } from "./shotgun/index.js";
import { radio } from "./radio/index.js";
import { shovel } from "./shovel/index.js";
import { stunTrap } from "./stun-trap/index.js";
import { walkie } from "./walkie/index.js";
import { corpse } from "./corpse/index.js";
import { bandage } from "./bandage/index.js";
import { turret } from "./turret/index.js";
import { teleporter } from "./teleporter/index.js";

export { credit } from "./scrap/index.js";

/**
 * Every item in the game. A new item is one entry here and its slice of config, which holds its
 * weight, uses and loot weight with the rest of its tuning.
 */
const ITEMS = [
  shovel,
  scrap,
  goldenScrap,
  handgun,
  shotgun,
  flashlight,
  walkie,
  radio,
  fuel,
  stunTrap,
  corpse,
  bandage,
  turret,
  teleporter,
] as const;

/** Each item's config, under its name, and how a new world lays loot. */
export type ItemsConfig = ContentConfig<(typeof ITEMS)[number]> & {
  readonly loot: LootConfig;
};

/** The world's items, and the loot a new world lays of them. */
export function itemContent(config: ItemsConfig): WorldContent[] {
  return [
    ...ITEMS.map((entry) => entry.create(config)),
    lootContent(config.loot),
  ];
}
