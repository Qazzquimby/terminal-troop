import type { Point } from "./map.js";
import type { Session } from "./session.js";

/**
 * An item use in progress, drawn above the player. Local-only, never sent over the network:
 * the item behaviour that starts the use supplies `draw`, so the core stays item-agnostic.
 */
export interface ItemUse {
  readonly startedAt: number;
  readonly endsAt: number;
  /** Draws the use at `now`; does nothing once it has finished. */
  readonly draw: (ctx: CanvasRenderingContext2D, now: number) => void;
}

/** A player's use of an item, as the host receives it: where the player stood and faced. */
export interface UseRequest {
  /** The id of the player using the item. */
  readonly by: string;
  readonly item: string;
  readonly x: number;
  readonly y: number;
  readonly aim: number;
}

/** What using an item does to the shared world. Runs only on the host. */
export interface ItemEffect {
  /** Minimum time between uses, in milliseconds. */
  readonly cooldownMs: number;
  /** Applies a use by a player standing at `at`, facing `aim`. */
  apply(game: Session, at: Point, aim: number): void;
}

/** How far the host trusts a use's report of where and when it happened. */
export interface UseSlack {
  /** Furthest, in pixels, a use may be from where its player was last reported. */
  readonly distance: number;
  /** How much sooner than its cooldown allows a use may arrive, in seconds. */
  readonly seconds: number;
}

export function registerItem(
  game: Session,
  id: string,
  effect: ItemEffect,
): void {
  if (game.items.has(id)) throw new Error(`Item already registered: ${id}`);
  game.items.set(id, effect);
}

/** Queues a use for the host's next step. */
export function requestUse(game: Session, request: UseRequest): void {
  game.uses.push(request);
}

/** Whether the host accepts `request`: near where its player was last reported, and off cooldown. */
function accepts(
  game: Session,
  request: UseRequest,
  effect: ItemEffect,
): boolean {
  const player = game.players.get(request.by);
  if (player === undefined) return false;
  const known = player === game.local ? player : { x: player.tx, y: player.ty };
  const { distance, seconds } = game.config.net.useSlack;
  if (Math.hypot(request.x - known.x, request.y - known.y) > distance)
    return false;
  const readyAt = game.readyAt.get(request.by) ?? -Infinity;
  if (game.time < readyAt - seconds) return false;
  game.readyAt.set(request.by, game.time + effect.cooldownMs / 1000);
  return true;
}

/** Applies every queued use the host accepts, then empties the queue. */
export function applyUses(game: Session): void {
  const requests = game.uses.splice(0);
  if (!game.hosting) return;
  for (const request of requests) {
    const effect = game.items.get(request.item);
    if (effect === undefined || !accepts(game, request, effect)) continue;
    effect.apply(game, request, request.aim);
  }
}
