import {
  canSeeFrom,
  directionalVision,
  isGhost,
  livingPlayers,
} from "../sim/index.js";
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
 * The nearest living player `self` sees all round it within `range` along a clear line, or null.
 */
export function nearestSeenPlayer(
  game: Session,
  self: Point,
  range: number,
): Player | null {
  const source = { x: self.x, y: self.y, range };
  let nearest: Player | null = null;
  let nearestDistance = Infinity;
  for (const player of livingPlayers(game)) {
    const distance = Math.hypot(player.x - self.x, player.y - self.y);
    if (distance >= nearestDistance) continue;
    if (!canSeeFrom(game.world.map, source, player)) continue;
    nearest = player;
    nearestDistance = distance;
  }
  return nearest;
}

/**
 * Whether some living player looks at `at`: it lies in their view cone, however far, along a clear
 * line. The small circle every player sees all round them does not count, nor does light: a
 * player looking into the dark at it still looks at it. Ghosts' eyes do not count.
 */
export function isLookedAt(game: Session, at: Point): boolean {
  return livingPlayers(game).some((player) => {
    const [cone] = directionalVision(player, player.aim, game.config.vision);
    return canSeeFrom(game.world.map, cone, at);
  });
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

/** Whether the player or world entity `id` is gone from the world, dead, or a ghost. */
export function isGone(game: Session, id: string): boolean {
  const player = game.players.get(id);
  if (player !== undefined) return isGhost(player);
  const entity = game.entities.get(id);
  return entity === undefined || entity.health <= 0;
}
