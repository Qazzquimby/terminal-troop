import { areaAt, clockFace, clockMinutes } from "../sim/index.js";
import type { Point, Session } from "../sim/index.js";

/**
 * The segments each digit lights on a seven-segment display, in the order a, b, c, d, e, f, g:
 * top, top right, bottom right, bottom, bottom left, top left, middle.
 */
const DIGIT_SEGMENTS: Readonly<Record<string, string>> = {
  "0": "1111110",
  "1": "0110000",
  "2": "1101101",
  "3": "1111001",
  "4": "0110011",
  "5": "1011011",
  "6": "1011111",
  "7": "1110000",
  "8": "1111111",
  "9": "1111011",
};

/** A digit's size on the display, and its segments' thickness, in screen pixels. */
const DIGIT = { width: 14, height: 26, thick: 3, gap: 6 } as const;
const MARGIN = 14;
const PADDING = 8;
const LIT = "#ff5a3c";
/** Unlit segments still show faintly, as on a real LCD. */
const UNLIT = "rgba(255, 90, 60, 0.1)";
const FACE = "rgba(10, 6, 6, 0.8)";

/** The box of each segment of a digit at `x`, `y`, in a, b, ... g order. */
function segmentBoxes(
  x: number,
  y: number,
): [number, number, number, number][] {
  const { width: w, height: h, thick: t } = DIGIT;
  const half = h / 2;
  return [
    [x + t, y, w - t * 2, t],
    [x + w - t, y + t, t, half - t * 1.5],
    [x + w - t, y + half + t / 2, t, half - t * 1.5],
    [x + t, y + h - t, w - t * 2, t],
    [x, y + half + t / 2, t, half - t * 1.5],
    [x, y + t, t, half - t * 1.5],
    [x + t, y + half - t / 2, w - t * 2, t],
  ];
}

function drawDigit(
  ctx: CanvasRenderingContext2D,
  digit: string,
  x: number,
  y: number,
): void {
  const lit = DIGIT_SEGMENTS[digit] ?? "0000000";
  segmentBoxes(x, y).forEach(([bx, by, bw, bh], i) => {
    ctx.fillStyle = lit[i] === "1" ? LIT : UNLIT;
    ctx.fillRect(bx, by, bw, bh);
  });
}

/**
 * Width of the display's four digits and colon (" 8:05", "12:00"): a colon takes a gap's width,
 * between the gaps either side of it.
 */
const DIGITS_WIDTH = 4 * (DIGIT.width + DIGIT.gap);

/**
 * Whether the time shows to whoever sees through `viewer`: while it stands on the road, lit or
 * not, as any body there could read the sky.
 */
export const showsClock = (game: Session, viewer: Point): boolean =>
  areaAt(game.world, viewer) === "road";

/**
 * The world's time of day in the top right of the screen, as a segmented LCD clock shows it,
 * while `viewer` stands on the road. Its colon blinks each real second, `now` in milliseconds.
 */
export function drawClock(
  ctx: CanvasRenderingContext2D,
  game: Session,
  viewer: Point,
  view: { readonly width: number },
  now: number,
): void {
  if (!showsClock(game, viewer)) return;
  const face = clockFace(clockMinutes(game.config.day, game.worldTime));
  const digits = face.digits.padStart(5, " ");
  const label = 18;
  const width = DIGITS_WIDTH + PADDING * 3 + label;
  const height = DIGIT.height + PADDING * 2;
  const left = view.width - MARGIN - width;
  ctx.save();
  ctx.fillStyle = FACE;
  ctx.fillRect(left, MARGIN, width, height);
  let x = left + PADDING;
  const y = MARGIN + PADDING;
  for (const char of digits) {
    if (char === ":") {
      ctx.fillStyle = Math.floor(now / 1000) % 2 === 0 ? LIT : UNLIT;
      const t = DIGIT.thick;
      const at = x - t / 2;
      ctx.fillRect(at, y + DIGIT.height * 0.3, t, t);
      ctx.fillRect(at, y + DIGIT.height * 0.65, t, t);
      x += DIGIT.gap;
      continue;
    }
    drawDigit(ctx, char, x, y);
    x += DIGIT.width + DIGIT.gap;
  }
  ctx.font = "bold 10px monospace";
  ctx.textBaseline = "top";
  ctx.fillStyle = LIT;
  ctx.fillText(face.meridiem, x - DIGIT.gap + PADDING, y);
  ctx.restore();
}
