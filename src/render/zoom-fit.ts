import { visibilityPolygon } from "../sim/index.js";
import type { Point, TileMap, ViewConfig } from "../sim/index.js";
import { turned } from "./camera.js";
import type { Camera } from "./camera.js";

/** How the camera zooms so the furthest of the map in sight fits on the screen. */
export interface ZoomFitConfig {
  /**
   * Whether the zoom fits what is in sight with the camera upright too; otherwise only while it
   * turns with the view, and upright it keeps its configured zoom.
   */
  readonly always: boolean;
  /** Rays traced round the eye to find how far it sees. */
  readonly rays: number;
  /** Factor on the zoom that just fits the furthest point seen, to leave room round it. */
  readonly margin: number;
  /** The closest the fitted zoom comes in, as a zoom-out factor like the camera's own. */
  readonly min: number;
  /** The furthest the fitted zoom goes out. */
  readonly max: number;
  /**
   * Rate, per second, at which the fitted zoom eases towards what fits: slower than the camera's
   * own zoom ease, so stepping through a door glides out rather than jumps.
   */
  readonly rate: number;
}

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

/** Eases a fraction of the way from `from` to `to` set by `rate` per second over `dt` seconds. */
function ease(from: number, to: number, rate: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

/**
 * A zoom that follows how far the eye sees: each frame, `step` traces the map round the eye and
 * eases towards the zoom that fits the furthest of it on the screen, kept within the configured
 * bounds. It gives a factor on the camera's configured zoom, for `updateCamera`'s `scale`, so a
 * ghost's wheel zoom multiplies with it.
 */
export function createZoomFit(config: ZoomFitConfig) {
  /** The fitted zoom, eased; null while not fitting, so fitting again starts afresh. */
  let zoom: number | null = null;
  return {
    /**
     * The factor on `camera`'s configured zoom to ease to this frame, `dt` seconds on, with its
     * eye at `eye` on `map`. With the camera not `turning` with the view it is 1,
     * the configured zoom, unless `config.always`.
     */
    step(
      camera: Camera,
      map: TileMap,
      eye: Point,
      dt: number,
      turning: boolean,
    ): number {
      const base = camera.config.zoom;
      if (!turning && !config.always) {
        zoom = null;
        return 1;
      }
      const { view } = camera;
      const reach = config.max * Math.hypot(view.width / 2, view.height);
      const { points } = visibilityPolygon(map, eye, config.rays, reach);
      const fits = zoomToFit(
        view,
        camera.roll,
        camera.anchor,
        eye,
        points,
        config.margin,
      );
      const target = Math.min(config.max, Math.max(config.min, fits));
      zoom = zoom === null ? base : ease(zoom, target, config.rate, dt);
      return zoom / base;
    },
  };
}
