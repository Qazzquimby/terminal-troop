import type { Point, ViewConfig } from "../sim/index.js";

/** How far the camera eases toward its target zoom each update. */
const ZOOM_SMOOTHING = 0.2;
/** Even a huge light stops being useful past this much zoom-out. */
const MAX_ZOOM_OUT = 4;

/** The top-left corner of the view in world space, the view's size, and its zoom. */
export interface Camera extends Point {
  readonly view: ViewConfig;
  /** Zoom-out factor: 1 shows the view at 1:1, larger shows more world. */
  zoom: number;
  /** Zoom the camera eases toward. */
  targetZoom: number;
}

export interface ZoomRange {
  readonly min: number;
  readonly max: number;
}

export function createCamera(view: ViewConfig): Camera {
  return { x: 0, y: 0, view, zoom: 1, targetZoom: 1.25 };
}

/**
 * The zoom-out factors worth offering: never tighter than 1:1, never looser than needed to fit
 * the player's whole sight radius, and capped so a huge light cannot zoom out into the fog.
 */
export function zoomRange(
  view: ViewConfig,
  sightRange: number,
  cap: number = MAX_ZOOM_OUT,
): ZoomRange {
  const fit = (2 * sightRange) / Math.min(view.width, view.height);
  return { min: 1, max: Math.max(1, Math.min(cap, fit)) };
}

export function setZoomTarget(
  camera: Camera,
  zoom: number,
  range: ZoomRange,
): void {
  camera.targetZoom = Math.min(range.max, Math.max(range.min, zoom));
}

export function updateCamera(camera: Camera, target: Point): void {
  camera.zoom += (camera.targetZoom - camera.zoom) * ZOOM_SMOOTHING;
  const halfWidth = (camera.view.width * camera.zoom) / 2;
  const halfHeight = (camera.view.height * camera.zoom) / 2;
  camera.x = target.x - halfWidth;
  camera.y = target.y - halfHeight;
}
