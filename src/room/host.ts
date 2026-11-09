/** A player the host can be chosen from. */
export interface Candidate {
  readonly id: string;
  /** Heard from recently, with its page visible. */
  readonly active: boolean;
}

/**
 * The host: the lowest id among the active candidates, or among them all when none is
 * active. Hidden pages throttle their timers, so a hidden player hosts only when no one
 * else can.
 */
export function electHost(first: Candidate, rest: Iterable<Candidate>): string {
  let best = first;
  for (const candidate of rest) {
    if (
      (candidate.active && !best.active) ||
      (candidate.active === best.active && candidate.id < best.id)
    )
      best = candidate;
  }
  return best.id;
}
