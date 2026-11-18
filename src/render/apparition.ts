import type { Apparition, Point } from "../sim/index.js";

/** What of a canvas an apparition is drawn with. */
export type ApparitionContext = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "translate"
  | "beginPath"
  | "arc"
  | "clip"
  | "fillRect"
  | "globalAlpha"
  | "fillStyle"
>;

/** Milliseconds each moment lasts that an apparition jolts in or not, so a jolt holds a few frames. */
const JOLT_MOMENT = 90;

/** How faint, as a share of the apparition, the copy it leaves where it stood as it jolts. */
const AFTERIMAGE = 0.35;

/** How far past its radius the static round an apparition reaches, as a share of the radius. */
const STATIC_REACH = 1.15;

/** The side, in pixels, of each grain of static. */
const GRAIN = 2;

/** Milliseconds the bright band rolling down through the static takes to pass once. */
const ROLL = 1400;

/** A number in [0, 1) fixed by `n`, the same each time it is asked: a moment's roll of the dice. */
function hashed(n: number): number {
  const x = Math.sin(n * 12.9898) * 43_758.5453;
  return x - Math.floor(x);
}

/**
 * How far an apparition stands off where it is at `now`, in milliseconds: its jolt aside, held
 * for the moment it falls in, 0 between jolts.
 */
export function joltAt(style: Apparition, now: number): number {
  const moment = Math.floor(now / JOLT_MOMENT);
  if (hashed(moment) >= style.jolt.chance) return 0;
  return hashed(moment + 0.5) < 0.5 ? -style.jolt.size : style.jolt.size;
}

/** Static over a disc of `radius` round `at`, `thickness` 0..1, with a bright band rolling down it. */
function drawStatic(
  ctx: ApparitionContext,
  at: Point,
  radius: number,
  thickness: number,
  now: number,
): void {
  if (thickness <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
  ctx.clip();
  const band = at.y - radius + ((now % ROLL) / ROLL) * radius * 2;
  for (let y = at.y - radius; y < at.y + radius; y += GRAIN) {
    const lit = Math.abs(y - band) < radius * 0.15;
    for (let x = at.x - radius; x < at.x + radius; x += GRAIN) {
      // Not every grain shows: the gaps let what it covers flicker through.
      if (Math.random() > thickness) continue;
      const shade =
        Math.floor(Math.random() * (lit ? 80 : 255)) + (lit ? 175 : 0);
      ctx.fillStyle = `rgba(${String(shade)}, ${String(shade)}, ${String(shade)}, ${String(thickness)})`;
      ctx.fillRect(x, y, GRAIN, GRAIN);
    }
  }
  ctx.restore();
}

/**
 * Draws `body` as an apparition in `style`, at `now`, in milliseconds, `draw` drawing it as its
 * kind does: see-through, trembling where it stands, now and then lurching aside with a faint copy
 * left behind, and crawling with static.
 */
export function drawApparition(
  ctx: ApparitionContext,
  body: Point & { readonly radius: number },
  style: Apparition,
  now: number,
  draw: () => void,
): void {
  const tremble = (): number => (Math.random() * 2 - 1) * style.shake;
  const jolt = joltAt(style, now);
  // Its opacity wavers a little, frame to frame, as a weak signal does.
  const opacity = style.opacity * (0.85 + 0.15 * Math.random());
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (jolt !== 0) {
    ctx.save();
    ctx.globalAlpha *= AFTERIMAGE;
    draw();
    ctx.restore();
  }
  const shift = { x: jolt + tremble(), y: tremble() };
  ctx.translate(shift.x, shift.y);
  ctx.save();
  draw();
  ctx.restore();
  drawStatic(ctx, body, body.radius * STATIC_REACH, style.static, now);
  ctx.restore();
}
