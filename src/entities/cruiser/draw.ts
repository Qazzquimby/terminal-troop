import { onScreenAngle, upright } from "../../lib/upright/index.js";
import { occupantsOf } from "../../sim/index.js";
import type { BoxSize, Point, Session, WorldEntity } from "../../sim/index.js";
import type { CruiserState } from "./drive.js";

const COLOURS = {
  names: "#eee",
  powered: "#3b6ea5",
  unpowered: "#4b5560",
  roof: "rgba(255, 255, 255, 0.12)",
  glass: "#9fd3ff",
  lamp: "#fff3b0",
  fuel: "#e6c84a",
  damage: "#d8473a",
  gauge: "rgba(0, 0, 0, 0.6)",
};

/**
 * Where the cruiser is drawn, and the way it points: for the local player at its wheel, where its
 * own client has driven it, so the car does not trail behind its driver; otherwise where the host
 * last put it.
 */
function placed(
  game: Session,
  entity: WorldEntity,
  state: CruiserState,
): { at: Point; heading: number } {
  const { ride } = game.local;
  if (ride?.vehicle === entity.id && ride.driving)
    return { at: game.local, heading: ride.heading };
  return { at: entity, heading: state.heading };
}

/** A gauge bar under the car, `share` full. */
function gauge(
  ctx: CanvasRenderingContext2D,
  at: Point,
  y: number,
  width: number,
  share: number,
  colour: string,
): void {
  ctx.fillStyle = COLOURS.gauge;
  ctx.fillRect(at.x - width / 2 - 1, y - 1, width + 2, 5);
  ctx.fillStyle = colour;
  ctx.fillRect(at.x - width / 2, y, width * Math.min(1, share), 3);
}

/** The mark before the name of whoever is at the wheel. */
const WHEEL_MARK = "🛞";

/**
 * Who is inside the cruiser, for everyone who sees it: how many and their names, in a row across
 * its roof, centred on `at`, the driver's marked with a wheel. On the roof, it shows wherever the
 * car does, not in the dark beside it.
 */
function drawOccupants(
  ctx: CanvasRenderingContext2D,
  game: Session,
  entity: WorldEntity,
  at: Point,
): void {
  const inside = occupantsOf(game, entity.id);
  if (inside.length === 0) return;
  const names = inside.map((player) =>
    player.ride?.driving === true ? `${WHEEL_MARK}${player.name}` : player.name,
  );
  const text = `${String(inside.length)} in: ${names.join(", ")}`;
  ctx.save();
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = ctx.measureText(text).width;
  upright(ctx, at, () => {
    ctx.fillStyle = COLOURS.gauge;
    ctx.fillRect(at.x - width / 2 - 4, at.y - 8, width + 8, 16);
    ctx.fillStyle = COLOURS.names;
    ctx.fillText(text, at.x, at.y);
  });
  ctx.restore();
}

/**
 * The cruiser seen from above, its body the box of `size` pointing along its heading: windscreen
 * and headlamps at its front, lamps lit while it has fuel. Under it, its fuel gauge while it has
 * fuel, against `fullTank`, and its damage towards breaking down once it has taken any.
 */
export function drawCruiser(
  ctx: CanvasRenderingContext2D,
  entity: WorldEntity,
  state: CruiserState,
  game: Session,
  size: BoxSize,
  gauges: { readonly fullTank: number; readonly breakdown: number },
): void {
  const { at, heading } = placed(game, entity, state);
  const { length, width } = size;
  const powered = state.fuel > 0;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(heading);
  ctx.fillStyle = powered ? COLOURS.powered : COLOURS.unpowered;
  ctx.beginPath();
  ctx.roundRect(-length / 2, -width / 2, length, width, width * 0.2);
  ctx.fill();
  ctx.fillStyle = COLOURS.roof;
  ctx.fillRect(-length * 0.25, -width * 0.38, length * 0.4, width * 0.76);
  ctx.fillStyle = COLOURS.glass;
  ctx.fillRect(length * 0.17, -width * 0.36, length * 0.08, width * 0.72);
  ctx.fillStyle = powered ? COLOURS.lamp : COLOURS.unpowered;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(length / 2 - 6, side * width * 0.32, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  // Just under the body on the screen, however it and the camera are turned.
  const onScreen = onScreenAngle(ctx, heading);
  const reach =
    (Math.abs(Math.sin(onScreen)) * length +
      Math.abs(Math.cos(onScreen)) * width) /
    2;
  drawOccupants(ctx, game, entity, at);
  const below = at.y + reach + 10;
  upright(ctx, at, () => {
    if (powered)
      gauge(
        ctx,
        at,
        below,
        length * 0.5,
        state.fuel / gauges.fullTank,
        COLOURS.fuel,
      );
    if (state.damage > 0)
      gauge(
        ctx,
        at,
        below + 7,
        length * 0.5,
        state.damage / gauges.breakdown,
        COLOURS.damage,
      );
  });
}
