import { lerpAngle } from "../sim/index.js";
import type { Point, ViewConfig } from "../sim/index.js";

/** How the camera turns, when it turns with the view's facing. */
interface RollConfig {
  /** Rate, per second, at which the camera's turn eases towards the view's facing, and back. */
  readonly rate: number;
  /**
   * How far down the view the eye sits while the camera turns, as a fraction of its height:
   * past the middle, more of what lies ahead shows.
   */
  readonly anchor: number;
}

/** How the camera frames the player. */
export interface CameraConfig {
  /** Zoom-out factor the camera settles at: 1 shows the view at 1:1, larger shows more world. */
  readonly zoom: number;
  /** Rate, per second, at which the zoom eases towards `zoom`. */
  readonly zoomRate: number;
  /** Rate, per second, at which the view's centre eases towards its target. */
  readonly followRate: number;
  /** A target further than this, in pixels, from the view's centre is jumped to, not eased to. */
  readonly snapDistance: number;
  readonly roll: RollConfig;
}

/**
 * What the view shows of the world. Its point is the top-left corner of the world-aligned box
 * round all the view shows, `width` by `height` world units: the view itself when it is not
 * turned, and a larger box round it when it is.
 */
export interface Camera extends Point {
  readonly view: ViewConfig;
  readonly config: CameraConfig;
  /** Zoom-out factor: 1 shows the view at 1:1, larger shows more world. */
  zoom: number;
  /** The world point the eye is on; null until it first has a target. */
  focus: Point | null;
  /**
   * Radians the world is turned on the screen, clockwise: 0 keeps the world's up at the top;
   * `-π/2 - facing` puts `facing` at the top.
   */
  roll: number;
  /** How far down the view the focus sits, as a fraction of its height: ½ at the middle. */
  anchor: number;
  /** The width of the world-aligned box round all the view shows, in world units. */
  width: number;
  /** The height of the world-aligned box round all the view shows, in world units. */
  height: number;
}

/** A camera at 1:1, about to ease out to its configured zoom. */
export function createCamera(view: ViewConfig, config: CameraConfig): Camera {
  return {
    x: 0,
    y: 0,
    view,
    config,
    zoom: 1,
    focus: null,
    roll: 0,
    anchor: 0.5,
    width: view.width,
    height: view.height,
  };
}

/** Where on the screen, in view (CSS pixel) space, the focus is drawn. */
function eyeOnScreen(camera: Camera): Point {
  return { x: camera.view.width / 2, y: camera.view.height * camera.anchor };
}

/** The world point the eye is on; before it has one, the middle of its box. */
function focusOf(camera: Camera): Point {
  return (
    camera.focus ?? {
      x: camera.x + camera.width / 2,
      y: camera.y + camera.height / 2,
    }
  );
}

/** `v` turned `angle` radians clockwise, as the screen sees it. */
function turned(v: Point, angle: number): Point {
  if (angle === 0) return { x: v.x, y: v.y };
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

/**
 * The world point under `point`, given in view (CSS pixel) space. Inverts the transform that
 * `toViewSpace` applies, so it stays correct at any zoom and turn.
 */
export function screenToWorld(camera: Camera, point: Point): Point {
  const eye = eyeOnScreen(camera);
  const focus = focusOf(camera);
  const off = turned(
    {
      x: (point.x - eye.x) * camera.zoom,
      y: (point.y - eye.y) * camera.zoom,
    },
    -camera.roll,
  );
  return { x: focus.x + off.x, y: focus.y + off.y };
}

/** Where `point`, in world space, falls on the screen, in view (CSS pixel) space. */
export function worldToScreen(camera: Camera, point: Point): Point {
  const eye = eyeOnScreen(camera);
  const focus = focusOf(camera);
  const off = turned(
    {
      x: (point.x - focus.x) / camera.zoom,
      y: (point.y - focus.y) / camera.zoom,
    },
    camera.roll,
  );
  return { x: eye.x + off.x, y: eye.y + off.y };
}

/** The world direction a direction on the screen points, such as up the screen for ahead. */
export function screenToWorldDirection(
  camera: Camera,
  direction: Point,
): Point {
  return turned(direction, -camera.roll);
}

/** What turning a context from world space to view space needs of it. */
type TransformContext = Pick<
  CanvasRenderingContext2D,
  "translate" | "rotate" | "scale"
>;

/** Transforms `ctx` from world space to view space, as `worldToScreen` maps a point. */
export function toViewSpace(ctx: TransformContext, camera: Camera): void {
  const eye = eyeOnScreen(camera);
  const focus = focusOf(camera);
  ctx.translate(eye.x, eye.y);
  if (camera.roll !== 0) ctx.rotate(camera.roll);
  ctx.scale(1 / camera.zoom, 1 / camera.zoom);
  ctx.translate(-focus.x, -focus.y);
}

/** Eases a fraction of the way from `from` to `to` set by `rate` per second over `dt` seconds. */
function ease(from: number, to: number, rate: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

/** Points the eye at `focus`, and fits the world-aligned box round the view to it. */
function frame(camera: Camera, focus: Point): void {
  camera.focus = { x: focus.x, y: focus.y };
  const { width, height } = camera.view;
  const corners = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ].map((corner) => screenToWorld(camera, corner));
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  camera.x = Math.min(...xs);
  camera.y = Math.min(...ys);
  camera.width = Math.max(...xs) - camera.x;
  camera.height = Math.max(...ys) - camera.y;
}

/** Below this many radians off, a turn is taken as done. */
const SETTLED = 1e-4;

/**
 * Eases the camera's turn towards putting `facing` (radians) at the top of the screen, along
 * the shorter way round, or back to the world's up when `facing` is null; the eye moves down the
 * view as it turns, and back.
 */
function roll(camera: Camera, facing: number | null, dt: number): void {
  const { rate, anchor } = camera.config.roll;
  const target = facing === null ? 0 : -Math.PI / 2 - facing;
  const next = lerpAngle(camera.roll, target, 1 - Math.exp(-rate * dt));
  // Settled back upright exactly, so an unturned view maps points with no rounding.
  camera.roll = facing === null && Math.abs(next) < SETTLED ? 0 : next;
  const towards = facing === null ? 0.5 : anchor;
  camera.anchor =
    Math.abs(camera.anchor - towards) < SETTLED
      ? towards
      : ease(camera.anchor, towards, rate, dt);
}

/**
 * Eases the zoom towards its configured zoom times `scale`, the view's centre towards `target`,
 * and the turn towards putting `facing` at the top of the screen (or back upright when null),
 * over `dt` seconds. A camera with no focus yet, or one further than its snap distance from
 * `target`, jumps straight to it.
 */
export function updateCamera(
  camera: Camera,
  target: Point,
  dt: number,
  scale = 1,
  facing: number | null = null,
): void {
  const { zoom, zoomRate, followRate, snapDistance } = camera.config;
  camera.zoom = ease(camera.zoom, zoom * scale, zoomRate, dt);
  roll(camera, facing, dt);
  const { focus } = camera;
  if (
    focus === null ||
    Math.hypot(target.x - focus.x, target.y - focus.y) > snapDistance
  ) {
    frame(camera, target);
    return;
  }
  frame(camera, {
    x: ease(focus.x, target.x, followRate, dt),
    y: ease(focus.y, target.y, followRate, dt),
  });
}

/** Centres the view on `target` at once, as on entering a room. */
export function snapCamera(camera: Camera, target: Point): void {
  frame(camera, target);
}
