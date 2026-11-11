import type { Point } from "./map.js";
import type { Player } from "./player.js";
import type { Session } from "./session.js";

/** Tuning for a swing of the held tool. */
export interface SwingConfig {
  /** The radius of the hitbox, in pixels. */
  readonly radius: number;
  /** How far in front of the player the hitbox is centred, in pixels. */
  readonly reach: number;
  /** Minimum time between swings, in milliseconds. */
  readonly cooldownMs: number;
  /** How long a swing is shown, in milliseconds. */
  readonly durationMs: number;
}

/** Whether a swing connected. */
export interface SwingResult {
  readonly hit: boolean;
}

/** The hitbox centre, `reach` in front of the player along its aim. */
function hitboxCenter(player: Player, reach: number): Point {
  return {
    x: player.x + Math.cos(player.aim) * reach,
    y: player.y + Math.sin(player.aim) * reach,
  };
}

/** Whether any entity overlaps the hitbox. */
function anyEntityIn(session: Session, center: Point, radius: number): boolean {
  for (const entity of session.entities.values()) {
    const distance = Math.hypot(entity.x - center.x, entity.y - center.y);
    if (distance <= radius + entity.radius) return true;
  }
  return false;
}

/**
 * Swings the local player's tool at `now`, testing the hitbox in front of it.
 * Returns null while the previous swing is still cooling down.
 */
export function swing(
  session: Session,
  now: number,
  config: SwingConfig,
): SwingResult | null {
  const { local } = session;
  if (local.swing !== null && now - local.swing.startedAt < config.cooldownMs) {
    return null;
  }

  const center = hitboxCenter(local, config.reach);
  const hit = anyEntityIn(session, center, config.radius);
  local.swing = {
    startedAt: now,
    endsAt: now + config.durationMs,
    hit,
    center,
    radius: config.radius,
  };
  return { hit };
}
