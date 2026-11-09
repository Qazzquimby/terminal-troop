import { FIXED_DT, MAX_CATCH_UP_S, MAX_STEPS_PER_FRAME } from "./config.js";

/** Times in ms on the `performance.now()` clock. */
interface StepLimits {
  /** Length of one fixed step. */
  readonly dtMs: number;
  /** Most simulation time the clock may be ahead by; the excess is dropped. */
  readonly maxCatchUpMs: number;
  /** Most steps run in one frame; the rest wait for later frames. */
  readonly maxStepsPerFrame: number;
}

const STEP_LIMITS: StepLimits = {
  dtMs: FIXED_DT * 1000,
  maxCatchUpMs: MAX_CATCH_UP_S * 1000,
  maxStepsPerFrame: MAX_STEPS_PER_FRAME,
};

interface StepPlan {
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

/** How far into the next fixed step `elapsed` reaches, as a fraction clamped to 0..1. */
export function stepAlpha(elapsed: number, step: number): number {
  return Math.min(Math.max(elapsed / step, 0), 1);
}

/** Fixed-step sim time, in ms on the `performance.now()` clock. */
export function createSimClock(limits: StepLimits = STEP_LIMITS) {
  /** The time up to which the simulation has run. */
  let simTime = 0;
  return {
    /** Starts the simulation at `now`, with no steps owed. */
    reset(now: number): void {
      simTime = now;
    },
    /**
     * Runs this frame's steps towards `now`. `step` gets each step's end time, so input up to
     * that time lands in the step it happened in. `alpha` is how far `now` reaches into the
     * next step.
     */
    advance(
      now: number,
      step: (until: number) => void,
    ): { steps: number; alpha: number } {
      const plan = planSteps(simTime, now, limits);
      for (let i = 1; i <= plan.steps; i++)
        step(plan.simTime + i * limits.dtMs);
      simTime = plan.simTime + plan.steps * limits.dtMs;
      return {
        steps: plan.steps,
        alpha: stepAlpha(now - simTime, limits.dtMs),
      };
    },
  };
}
