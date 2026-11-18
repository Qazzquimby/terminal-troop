/** A point in world space. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Radians each context is turned from world space to the screen, while it draws in world space
 * under a turned camera; a context not listed is not turned.
 */
const rolls = new WeakMap<object, number>();

/** What standing a drawing upright needs of a context. */
export type UprightContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "translate" | "rotate"
>;

/**
 * Runs `draw` with `ctx` known to be turned `roll` radians on the screen, as a turned camera
 * turns the world, so what `upright` draws in it can stand upright again.
 */
export function withRoll(ctx: object, roll: number, draw: () => void): void {
  const before = rolls.get(ctx);
  rolls.set(ctx, roll);
  try {
    draw();
  } finally {
    if (before === undefined) rolls.delete(ctx);
    else rolls.set(ctx, before);
  }
}

/**
 * Runs `draw` with `ctx` turned about `at`, in world space, so that the screen's up is up in it
 * however the camera is turned: for what must stay readable, such as text, glyphs and the bars
 * over a body's head, drawn about it in world space as ever.
 */
export function upright(
  ctx: UprightContext,
  at: Point,
  draw: () => void,
): void {
  const roll = rolls.get(ctx) ?? 0;
  if (roll === 0) {
    draw();
    return;
  }
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(-roll);
  ctx.translate(-at.x, -at.y);
  withRoll(ctx, 0, draw);
  ctx.restore();
}

/** The angle on the screen of `angle`, a direction in world space drawn on `ctx`. */
export function onScreenAngle(ctx: object, angle: number): number {
  return angle + (rolls.get(ctx) ?? 0);
}
