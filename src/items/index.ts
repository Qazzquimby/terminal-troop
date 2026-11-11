import { inventory } from "../sim/index.js";
import type { ContentConfig, WorldContent } from "../sim/index.js";
import { shovel } from "./shovel/index.js";

/** Every item in the game. */
const ITEMS = [shovel] as const;

/** Each item's config, under its name. */
export type ItemsConfig = ContentConfig<(typeof ITEMS)[number]>;

/** The world's items, and what each player holds of them. */
export function itemContent(config: ItemsConfig): WorldContent[] {
  return [inventory, ...ITEMS.map((entry) => entry.create(config))];
}
