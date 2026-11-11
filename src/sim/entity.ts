import type { Body } from "./collision.js";

/**
 * What every solid, damageable thing in the world shares: a physics body with health.
 * Players, monsters and destructible props (a barrel, say) are all entities.
 */
export interface Entity extends Body {
  radius: number;
  /** Current health; at 0 the entity is destroyed. */
  health: number;
  /** Health when at full. */
  readonly maxHealth: number;
}

/** Reduces an entity's health by `amount`, never below zero. Returns the health lost. */
export function applyDamage(entity: Entity, amount: number): number {
  const lost = Math.min(entity.health, Math.max(0, amount));
  entity.health -= lost;
  return lost;
}

/** Whether an entity has been destroyed. */
export function isDead(entity: Entity): boolean {
  return entity.health <= 0;
}
