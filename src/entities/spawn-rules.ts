import { besideWall, inRect, isLit, roadDistanceAt } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";
import { reachesRoad } from "./road-reach.js";

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
  /**
   * Whether it appears only where a body its size could walk to the road, by ways wide enough for
   * it, as `reachesRoad` has it: never shut in a pocket it cannot get out of. Anywhere when left
   * out.
   */
  readonly reachesRoad?: boolean;
}

/**
 * Whether a monster of a kind keeping `rules`, its body of half-size `radius`, may appear at
 * `at`: never in the world's start, where the players gather, nowhere lit unless its rules allow
 * light, only against a wall when its rules ask for one, only as far from the road as they ask,
 * and only where it could walk to the road when they ask that. Every monster kind's spawning, and
 * every move one makes to where it might have arrived, goes through it.
 */
export function spawnAllowed(
  game: Session,
  at: Point,
  rules: SpawnRules = {},
  radius = 0,
): boolean {
  if (inRect(game.world.layout.start, at)) return false;
  if (rules.besideWall === true && !besideWall(game.world.map, at))
    return false;
  // A world without a road, as the dev square, has none to keep off or reach.
  const road = game.world.layout.roadCentre.length > 0;
  if (road && roadDistanceAt(game.world, at) < (rules.offRoad ?? 0))
    return false;
  if (rules.inLight !== true && isLit(game, at)) return false;
  return !road || rules.reachesRoad !== true || reachesRoad(game, at, radius);
}
