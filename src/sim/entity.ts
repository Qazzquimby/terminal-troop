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
