/** Stamina tuning. */
export interface StaminaConfig {
  /** A full bar. */
  readonly max: number;
  /** Lost per second while sprinting. */
  readonly drain: number;
  /** Gained per second once regeneration starts. */
  readonly regen: number;
  /** Seconds without sprinting before regeneration starts. */
  readonly regenDelay: number;
  /** After hitting 0, sprint stays locked until stamina is back to this. */
  readonly recover: number;
}

export interface Stamina {
  readonly value: number;
  /** Set on reaching 0; blocks sprint until stamina is back to `recover`. */
  readonly exhausted: boolean;
  /** Seconds since the player last sprinted. */
  readonly rested: number;
}

export function createStamina(config: StaminaConfig): Stamina {
  return { value: config.max, exhausted: false, rested: config.regenDelay };
}

export function canSprint(stamina: Stamina): boolean {
  return !stamina.exhausted && stamina.value > 0;
}

export function updateStamina(
  stamina: Stamina,
  sprinting: boolean,
  dt: number,
  config: StaminaConfig,
): Stamina {
  if (sprinting) {
    const value = Math.max(0, stamina.value - config.drain * dt);
    return { value, exhausted: value === 0, rested: 0 };
  }

  const rested = Math.min(config.regenDelay, stamina.rested + dt);
  const value =
    rested >= config.regenDelay
      ? Math.min(config.max, stamina.value + config.regen * dt)
      : stamina.value;
  return {
    value,
    exhausted: stamina.exhausted && value < config.recover,
    rested,
  };
}

/**
 * `stamina` less `amount`, spent at once, which restarts the wait before regeneration; null
 * when there is not that much to spend.
 */
export function spendStamina(stamina: Stamina, amount: number): Stamina | null {
  if (stamina.value < amount) return null;
  const value = stamina.value - amount;
  return { value, exhausted: stamina.exhausted || value === 0, rested: 0 };
}
