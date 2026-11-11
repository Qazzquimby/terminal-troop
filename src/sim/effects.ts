import type { Session } from "./session.js";

/** A short-lived picture drawn over the world, on this client alone. */
export interface Effect {
  /** When it starts, in sim seconds. */
  readonly startedAt: number;
  /** How long it lasts, in sim seconds. */
  readonly duration: number;
  /** Draws it `progress` of the way through, from 0 to 1. */
  draw(ctx: CanvasRenderingContext2D, progress: number): void;
}

/** Shows `effect` on this client until it has run its course. */
export function showEffect(game: Session, effect: Effect): void {
  game.effects.push(effect);
}

/** Drops every effect that has run its course by the session's time. */
export function pruneEffects(game: Session): void {
  const live = game.effects.filter(
    (effect) => game.time <= effect.startedAt + effect.duration,
  );
  game.effects.splice(0, game.effects.length, ...live);
}

/** Draws every effect as of the session's time. */
export function drawEffects(
  ctx: CanvasRenderingContext2D,
  game: Session,
): void {
  for (const effect of game.effects) {
    const progress = (game.time - effect.startedAt) / effect.duration;
    if (progress < 0 || progress > 1) continue;
    ctx.save();
    effect.draw(ctx, progress);
    ctx.restore();
  }
}
