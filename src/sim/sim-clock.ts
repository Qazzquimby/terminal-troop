import { FIXED_DT, MAX_CATCH_UP_S, MAX_STEPS_PER_FRAME } from "./config.js";

/** Times in ms on the `performance.now()` clock. */
export interface StepLimits {
  /** Length of one fixed step. */
  readonly dtMs: number;
  /** Most simulation time the clock may be ahead by; the excess is dropped. */
  readonly maxCatchUpMs: number;
  /** Most steps run in one frame; the rest wait for later frames. */
  readonly maxStepsPerFrame: number;
}

export const STEP_LIMITS: StepLimits = {
  dtMs: FIXED_DT * 1000,
  maxCatchUpMs: MAX_CATCH_UP_S * 1000,
  maxStepsPerFrame: MAX_STEPS_PER_FRAME,
};

export interface StepPlan {
  /** Where the simulation starts this frame, after dropping time past the cap. */
  readonly simTime: number;
  /** Fixed steps to run this frame. */
  readonly steps: number;
}

/** How far to advance a simulation that has run up to `simTime` towards the clock at `target`. */
export function planSteps(
  simTime: number,
  target: number,
  limits: StepLimits,
): StepPlan {
  const start = Math.max(simTime, target - limits.maxCatchUpMs);
  const due = Math.max(Math.floor((target - start) / limits.dtMs), 0);
  return { simTime: start, steps: Math.min(due, limits.maxStepsPerFrame) };
}

/**
 * Runs this frame's steps towards `target`. `step` gets each step's end time, so input up to
 * that time lands in the step it happened in. Returns the new sim time and the steps run.
 */
export function advanceSim(
  simTime: number,
  target: number,
  step: (until: number) => void,
  limits: StepLimits = STEP_LIMITS,
): StepPlan {
  const plan = planSteps(simTime, target, limits);
  for (let i = 1; i <= plan.steps; i++) step(plan.simTime + i * limits.dtMs);
  return {
    simTime: plan.simTime + plan.steps * limits.dtMs,
    steps: plan.steps,
  };
}
