import { inRect, isLit } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";

/**
 * Whether a monster of any kind may appear at `at`: never in the world's start, where the players
 * gather, nor anywhere lit, by sunlight, a powered room's fixture, or a light something gives off
 * such as a flashlight. Every monster kind's spawning goes through it.
 */
export function spawnAllowed(game: Session, at: Point): boolean {
  return !inRect(game.world.layout.start, at) && !isLit(game, at);
}
