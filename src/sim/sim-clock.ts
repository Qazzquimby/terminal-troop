/** The fixed-step clock's tuning, in seconds. */
export interface SimClockConfig {
  /** Length of one fixed step. */
  readonly fixedDt: number;
  /** The simulation falls at most this far behind the clock; older time is dropped. */
  readonly maxCatchUpS: number;
  /** Most fixed steps one frame runs; a longer backlog spreads over the next frames. */
  readonly maxStepsPerFrame: number;
}

/** Times in ms on the `performance.now()` clock. */
interface StepLimits {
  /** Length of one fixed step. */
  readonly dtMs: number;
  /** Most simulation time the clock may be ahead by; the excess is dropped. */
  readonly maxCatchUpMs: number;
  /** Most steps run in one frame; the rest wait for later frames. */
  readonly maxStepsPerFrame: number;
}

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
  limits: StepLimits,
): StepPlan {
  const plan = planSteps(simTime, target, limits);
  for (let i = 1; i <= plan.steps; i++) step(plan.simTime + i * limits.dtMs);
  return {
    simTime: plan.simTime + plan.steps * limits.dtMs,
    steps: plan.steps,
  };
}

/** A fixed-step clock: the step length in seconds and ms, and `advance` under its limits. */
export function createSimClock(config: SimClockConfig) {
  const limits: StepLimits = {
    dtMs: config.fixedDt * 1000,
    maxCatchUpMs: config.maxCatchUpS * 1000,
    maxStepsPerFrame: config.maxStepsPerFrame,
  };
  return {
    dt: config.fixedDt,
    dtMs: limits.dtMs,
    advance: (
      simTime: number,
      target: number,
      step: (until: number) => void,
    ): StepPlan => advanceSim(simTime, target, step, limits),
  };
}
