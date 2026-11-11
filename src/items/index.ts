import type { ContentConfig, WorldContent } from "../sim/index.js";
import { shovel } from "./shovel/index.js";

/** Every item in the game. */
const ITEMS = [shovel] as const;

/** Each item's config, under its name. */
export type ItemsConfig = ContentConfig<(typeof ITEMS)[number]>;

/** The world's items. */
export function itemContent(config: ItemsConfig): WorldContent[] {
  return ITEMS.map((entry) => entry.create(config));
}
