import {
  destroyWalls,
  effect,
  isSweepFree,
  wallCellsIn,
} from "../sim/index.js";
import type {
  Point,
  Session,
  Sound,
  WallArea,
  WorldEntity,
} from "../sim/index.js";

/**
 * How a body breaks the walls in its way: by pressing into them. Any kind can declare one in its
 * config, keep the seconds it has pressed in its state and call `pressWalls` each step; its
 * routes, planned with `breakingCost`, then go through a wall wherever that is quicker than
 * walking round.
 */
export interface WallPress {
  /** Seconds of pressing a wall before it comes down. */
  readonly seconds: number;
  /** Seconds between two grinds heard as it presses. */
  readonly grindGap: number;
}

/** What a body pressing walls sounds: a grind as it presses, a crumble as they come down. */
export interface WallPressSounds {
  readonly grind: Sound;
  readonly crumble: Sound;
}

/** How far ahead of a body, in pixels, it feels for the wall it presses. */
const FEEL = 2;

/**
 * How many cells a body walking at `speed` could cover in the time `press` takes to break a wall:
 * what a wall costs its route, as `planRoute` takes it.
 */
export function breakingCost(
  press: WallPress,
  speed: number,
  cell: number,
): number {
  return (press.seconds * speed) / cell;
}

/**
 * The square a body of half-size `half` at `at` would fill a hair further on towards `toward`:
 * where it feels for the walls it presses.
 */
function feltArea(at: Point, half: number, toward: Point): WallArea {
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const distance = Math.hypot(dx, dy);
  const ahead = distance === 0 ? 0 : FEEL / distance;
  return {
    center: { x: at.x + dx * ahead, y: at.y + dy * ahead },
    radius: half,
    shape: "square",
  };
}

/**
 * Presses `self` into the walls between it and `toward`, the next point it heads for, for a step
 * of `dt`, as the host: the seconds it has now pressed, given `pressed` before. It presses only
 * while walls stand between it and that point and it is up against them; the count falls back to
 * 0 the step it is not. Once it reaches `press.seconds` the walls it presses come down, for every
 * client, crumbling, and it starts again at 0. It grinds as it starts pressing and every
 * `press.grindGap` seconds after.
 */
export function pressWalls(
  game: Session,
  self: WorldEntity,
  toward: Point | null,
  pressed: number,
  dt: number,
  press: WallPress,
  sounds: WallPressSounds,
): number {
  const { map } = game.world;
  if (toward === null || isSweepFree(map, self.radius, self, toward)) return 0;
  const area = feltArea(self, self.radius, toward);
  if (wallCellsIn(map, area).length === 0) return 0;
  const next = pressed + dt;
  if (next >= press.seconds) {
    destroyWalls(game, area);
    effect(
      game,
      {
        at: area.center,
        sound: sounds.crumble,
        flash: { radius: self.radius * 1.5, hit: false },
      },
      self,
    );
    return 0;
  }
  const grinds =
    pressed === 0 ||
    Math.floor(next / press.grindGap) !== Math.floor(pressed / press.grindGap);
  if (grinds) effect(game, { at: area.center, sound: sounds.grind }, self);
  return next;
}
