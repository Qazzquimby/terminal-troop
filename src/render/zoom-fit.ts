import { distanceToWall } from "../sim/index.js";
import type { Point, TileMap, ViewConfig } from "../sim/index.js";
import { turned } from "./camera.js";
import type { Camera } from "./camera.js";

/** How the camera zooms so the furthest of the map that shows fits on the screen. */
export interface ZoomFitConfig {
  /**
   * Whether the zoom fits what shows with the camera upright too; otherwise only while it turns
   * with the view, and upright it keeps its configured zoom.
   */
  readonly always: boolean;
  /** Rays traced round the eye to find how far it sees. */
  readonly rays: number;
  /** Pixels apart the points are that each ray is looked along at, back from the wall it ends on. */
  readonly step: number;
  /** Factor on the zoom that just fits the furthest point that shows, to leave room round it. */
  readonly margin: number;
  /** The closest the fitted zoom comes in, as a zoom-out factor like the camera's own. */
  readonly min: number;
  /** The furthest the fitted zoom goes out. */
  readonly max: number;
  /** Seconds between measures of what fits; between them the zoom glides on to the last. */
  readonly interval: number;
  /**
   * How far, as a fraction, what fits must move from the zoom being glided to before that is
   * changed, so small changes in what shows, such as turning a little, never wobble the zoom.
   */
  readonly deadBand: number;
  /** Seconds the zoom takes, about, to glide out to what fits: a critically damped spring's. */
  readonly outTime: number;
  /** As `outTime`, gliding in. */
  readonly inTime: number;
}

/** Whether a world point shows on the screen. */
export type Sees = (point: Point) => boolean;

/**
 * The zoom-out factor at which every one of `seen` (world points) shows on a view `view` wide and
 * high, its eye at `eye` drawn `anchor` of the way down and the world turned `roll`, times
 * `margin`. Points behind the eye are fitted within as far as ahead of it, not within the strip
 * below it, so a view pulled down the screen is not zoomed out for what lies behind.
 */
export function zoomToFit(
  view: ViewConfig,
  roll: number,
  anchor: number,
  eye: Point,
  seen: readonly Point[],
  margin: number,
): number {
  const half = view.width / 2;
  const ahead = view.height * anchor;
  const behind = Math.max(ahead, view.height * (1 - anchor));
  let fit = 0;
  for (const point of seen) {
    const off = turned({ x: point.x - eye.x, y: point.y - eye.y }, roll);
    fit = Math.max(
      fit,
      Math.abs(off.x) / half,
      off.y < 0 ? -off.y / ahead : off.y / behind,
    );
  }
  return fit * margin;
}

/**
 * The furthest point that `sees` says shows along each of `rays` rays round `eye`, at most `reach`
 * out: each ray is traced to the wall it ends on, then looked back along `step` pixels at a time
 * to the first point that shows; a ray with none that shows gives the eye itself. So a corridor
 * in sight to its end but dark past a light's reach gives only as far as it is lit.
 */
export function furthestSeen(
  map: TileMap,
  eye: Point,
  rays: number,
  reach: number,
  step: number,
  sees: Sees,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < rays; i++) {
    const angle = (i / rays) * Math.PI * 2;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    // Just short of the wall, so the point looked at is in the open, not on the wall's face.
    const wall = Math.max(0, distanceToWall(map, eye, direction, reach) - 1);
    let found: Point = eye;
    for (let distance = wall; distance > 0; distance -= step) {
      const point = {
        x: eye.x + direction.x * distance,
        y: eye.y + direction.y * distance,
      };
      if (sees(point)) {
        found = point;
        break;
      }
    }
    points.push(found);
  }
  return points;
}

interface Spring {
  value: number;
  speed: number;
}

/** Glides `spring` towards `goal` over `dt` seconds, taking about `time` seconds to arrive. */
function glide(spring: Spring, goal: number, time: number, dt: number): void {
  // A critically damped spring (Game Programming Gems 4, 1.10): it starts from rest and settles
  // without overshoot, so a change of what fits never jolts the zoom.
  const omega = 2 / Math.max(time, 1e-6);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = spring.value - goal;
  const temp = (spring.speed + omega * change) * dt;
  const value = goal + (change + temp) * decay;
  // Never past the goal, and once too close to it to see, on it.
  if (change > 0 === value < goal || Math.abs(value - goal) < 1e-4) {
    spring.value = goal;
    spring.speed = 0;
    return;
  }
  spring.speed = (spring.speed - omega * temp) * decay;
  spring.value = value;
}

const everything: Sees = () => true;

/**
 * A zoom that follows how far the eye sees: every `config.interval` seconds, `step` traces the
 * map round the eye, out only as far as what shows on the screen, and takes the zoom that fits
 * the furthest of it, kept within the configured bounds, as the zoom to glide to, unless that is
 * within the dead band of the one it glides to already. Each frame the zoom glides on, on a
 * critically damped spring, in log terms so twice as far out takes as long as twice as far in.
 * It gives a factor on the camera's configured zoom, for `updateCamera`'s `scale`, so a ghost's
 * wheel zoom multiplies with it.
 */
export function createZoomFit(config: ZoomFitConfig) {
  /** The fitted zoom's log, gliding; null while not fitting, so fitting again starts afresh. */
  let spring: Spring | null = null;
  /** The log of the zoom glided to. */
  let goal = 0;
  /** Seconds to the next measure. */
  let wait = 0;
  return {
    /**
     * Stops fitting, for a view that never fits, such as a ghost's free camera, whatever
     * `config.always` says: the factor is 1, the configured zoom, and fitting again starts afresh.
     */
    rest(): number {
      spring = null;
      return 1;
    },
    /**
     * The factor on `camera`'s configured zoom to ease to this frame, `dt` seconds on, with its
     * eye at `eye` on `map`, fitting what the test `sees` gives says shows; it is asked for only
     * when what fits is measured, and without it all the map in sight shows. With the camera not
     * `turning` with the view it is 1, the configured zoom, unless `config.always`.
     */
    step(
      camera: Camera,
      map: TileMap,
      eye: Point,
      dt: number,
      turning: boolean,
      sees: () => Sees = () => everything,
    ): number {
      const base = camera.config.zoom;
      if (!turning && !config.always) {
        spring = null;
        return 1;
      }
      const fresh = spring === null;
      wait -= dt;
      if (fresh || wait <= 0) {
        wait = config.interval;
        const { view } = camera;
        const reach = config.max * Math.hypot(view.width / 2, view.height);
        const seen = furthestSeen(
          map,
          eye,
          config.rays,
          reach,
          config.step,
          sees(),
        );
        const fits = zoomToFit(
          view,
          camera.roll,
          camera.anchor,
          eye,
          seen,
          config.margin,
        );
        const target = Math.log(
          Math.min(config.max, Math.max(config.min, fits)),
        );
        if (fresh || Math.abs(target - goal) > Math.log(1 + config.deadBand))
          goal = target;
      }
      if (spring === null) {
        spring = { value: Math.log(base), speed: 0 };
        return 1;
      }
      const time = goal > spring.value ? config.outTime : config.inTime;
      glide(spring, goal, time, dt);
      return Math.exp(spring.value) / base;
    },
  };
}
