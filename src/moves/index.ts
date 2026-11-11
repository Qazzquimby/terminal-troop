import type { ContentConfig, WorldContent } from "../sim/index.js";
import { kick } from "./kick/index.js";

/** Everything every player can do empty-handed. */
const MOVES = [kick] as const;

/** Each move's config, under its name. */
export type MovesConfig = ContentConfig<(typeof MOVES)[number]>;

/** The world's moves. */
export function moveContent(config: MovesConfig): WorldContent[] {
  return MOVES.map((entry) => entry.create(config));
}
