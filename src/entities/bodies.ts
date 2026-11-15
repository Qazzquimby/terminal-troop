import { eyesOf, inView, livingPlayers } from "../sim/index.js";
import type { Player, Point, Session, WorldEntity } from "../sim/index.js";
import { preyNear } from "./hunt.js";
import type { Prey } from "./hunt.js";

/**
 * Every living player and world entity touching `self`, itself, items lying about and those of
 * the kind tags in `ignores` aside.
 */
export function touching(
  game: Session,
  self: WorldEntity,
  ignores: readonly string[],
): Prey[] {
  return preyNear(game, self, (prey) => self.radius + prey.radius + 1, ignores);
}

/**
 * The nearest living player `self` sees with its kind's eyes, within `range` if given, along a
 * clear line, or null. A stunned or blind entity sees none.
 */
export function nearestSeenPlayer(
  game: Session,
  self: WorldEntity,
  range = Infinity,
): Player | null {
  const sight = eyesOf(game, self);
  let nearest: Player | null = null;
  let nearestDistance = Infinity;
  for (const player of livingPlayers(game)) {
    const distance = Math.hypot(player.x - self.x, player.y - self.y);
    if (distance >= nearestDistance) continue;
    if (!inView(game, sight, player, range)) continue;
    nearest = player;
    nearestDistance = distance;
  }
  return nearest;
}

/** A ring `width` thick round `body`, `colour`ed, `gap` further out than it usually stands. */
export function drawRing(
  ctx: CanvasRenderingContext2D,
  body: Point & { readonly radius: number },
  colour: string,
  width: number,
  gap: number,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(body.x, body.y, body.radius + 2 + gap, 0, Math.PI * 2);
  ctx.stroke();
}
