/**
 * Optional timing of the parts of a step, for benchmarks (#433). Off unless something turns it
 * on: then each timed part costs one null check, and `profileStart` reads no clock.
 */

/** Takes the time, in ms, each timed part of a step took. */
export interface StepProfile {
  add(label: string, ms: number): void;
}

let active: StepProfile | null = null;

/** Times the parts of every step from now on into `profile`; null turns timing off. */
export function profileSteps(profile: StepProfile | null): void {
  active = profile;
}

/** Whether a profile is timing steps, for a caller that builds its label at a cost. */
export const profiling = (): boolean => active !== null;

/** The clock to pass to `profileEnd`; 0 when timing is off. */
export const profileStart = (): number =>
  active === null ? 0 : performance.now();

/** Adds the time since `start` to `label`, when timing is on. */
export function profileEnd(label: string, start: number): void {
  if (active !== null) active.add(label, performance.now() - start);
}
