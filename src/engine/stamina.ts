import {
  STAMINA_DRAIN,
  STAMINA_MAX,
  STAMINA_RECOVER,
  STAMINA_REGEN,
  STAMINA_REGEN_DELAY,
} from "./config.js";

export interface Stamina {
  readonly value: number;
  /** Set on reaching 0; blocks sprint until `STAMINA_RECOVER`. */
  readonly exhausted: boolean;
  /** Seconds since the player last sprinted. */
  readonly rested: number;
}

export function createStamina(): Stamina {
  return { value: STAMINA_MAX, exhausted: false, rested: STAMINA_REGEN_DELAY };
}

export function canSprint(stamina: Stamina): boolean {
  return !stamina.exhausted && stamina.value > 0;
}

export function updateStamina(
  stamina: Stamina,
  sprinting: boolean,
  dt: number,
): Stamina {
  if (sprinting) {
    const value = Math.max(0, stamina.value - STAMINA_DRAIN * dt);
    return { value, exhausted: value === 0, rested: 0 };
  }

  const rested = Math.min(STAMINA_REGEN_DELAY, stamina.rested + dt);
  const value =
    rested >= STAMINA_REGEN_DELAY
      ? Math.min(STAMINA_MAX, stamina.value + STAMINA_REGEN * dt)
      : stamina.value;
  return {
    value,
    exhausted: stamina.exhausted && value < STAMINA_RECOVER,
    rested,
  };
}
