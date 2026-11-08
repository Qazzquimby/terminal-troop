import { FIXED_DT, MAX_CATCH_UP_S, MAX_FRAME_S } from "./config.js";

export interface FrameTime {
  /** Fixed steps to simulate with idle controls for time the page was hidden. */
  readonly idleSteps: number;
  /** Seconds to add to the accumulator and simulate with live input. */
  readonly live: number;
}

/**
 * Splits the real time since the last frame. Live time is clamped to `MAX_FRAME_S`, so a visible
 * stall drops its excess. Time the page was hidden is caught up in idle fixed steps, capped at
 * `MAX_CATCH_UP_S`.
 */
export function splitFrameTime(elapsed: number, hiddenFor: number): FrameTime {
  const live = Math.min(Math.max(elapsed, 0), MAX_FRAME_S);
  const away = Math.min(Math.max(hiddenFor, 0), MAX_CATCH_UP_S);
  return { idleSteps: Math.floor(away / FIXED_DT), live };
}
