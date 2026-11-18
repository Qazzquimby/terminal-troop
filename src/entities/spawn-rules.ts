import { besideWall, inRect, isLit, roadDistanceAt } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";

/** What a monster kind lets its spawns do, past the rules every kind keeps. */
export interface SpawnRules {
  /**
   * Whether it may appear in light, by sunlight, a powered room's fixture, or a light something
   * gives off such as a flashlight; false when left out, so it appears only in the dark.
   */
  readonly inLight?: boolean;
  /**
   * Whether it appears only in a cell with a wall on one of its four sides, as `besideWall` has
   * it; anywhere when left out.
   */
  readonly besideWall?: boolean;
  /**
   * Fewest cells from the road its cell must be, as `roadDistanceAt` counts them: 1 keeps it off
   * the road. When left out, the spawner's own `offRoad`, which every kind keeps unless it says
   * otherwise; anywhere at 0.
   */
  readonly offRoad?: number;
}

/**
 * Whether a monster of a kind keeping `rules` may appear at `at`: never in the world's start,
 * where the players gather, nowhere lit unless its rules allow light, only against a wall when its
 * rules ask for one, and only as far from the road as they ask. Every monster kind's spawning, and
 * every move one makes to where it might have arrived, goes through it.
 */
export function spawnAllowed(
  game: Session,
  at: Point,
  rules: SpawnRules = {},
): boolean {
  if (inRect(game.world.layout.start, at)) return false;
  if (rules.besideWall === true && !besideWall(game.world.map, at))
    return false;
  // A world without a road, as the dev square, has none to keep off.
  const road = game.world.layout.roadCentre.length > 0;
  if (road && roadDistanceAt(game.world, at) < (rules.offRoad ?? 0))
    return false;
  return rules.inLight === true || !isLit(game, at);
}
