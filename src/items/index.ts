import { lootContent } from "../sim/index.js";
import type { ContentConfig, LootConfig, WorldContent } from "../sim/index.js";
import { flashlight } from "./flashlight/index.js";
import { handgun } from "./handgun/index.js";
import { scrap } from "./scrap/index.js";
import { shotgun } from "./shotgun/index.js";
import { radio } from "./radio/index.js";
import { shovel } from "./shovel/index.js";
import { walkie } from "./walkie/index.js";

export { credit } from "./scrap/index.js";

/**
 * Every item in the game. A new item is one entry here and its slice of config, which holds its
 * weight, uses and loot weight with the rest of its tuning.
 */
const ITEMS = [
  shovel,
  scrap,
  handgun,
  shotgun,
  flashlight,
  walkie,
  radio,
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
