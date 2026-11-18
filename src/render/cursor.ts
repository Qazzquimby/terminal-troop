import type { Point } from "../sim/index.js";

/** How the game's own cursor looks, drawn while the mouse is captured to point (#496). */
export interface CursorLook {
  /** Pixels from the cursor's middle to the end of each arm of its cross. */
  readonly size: number;
  readonly colour: string;
  /** The dark edge round it, so it shows on light ground as on dark. */
  readonly edge: string;
}

/**
 * Draws the game's cursor at `at`, in view space, over all else: a cross, as the browser's
 * crosshair cursor over the game is, edged so it shows on any ground.
 */
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  at: Point,
  look: CursorLook,
): void {
  const { size } = look;
  const x = Math.round(at.x) + 0.5;
  const y = Math.round(at.y) + 0.5;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.lineCap = "square";
  ctx.strokeStyle = look.edge;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = look.colour;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}
