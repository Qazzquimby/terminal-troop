/** A player the host can be chosen from. */
export interface Candidate {
  readonly id: string;
  /** Heard from recently, with its page visible. */
  readonly active: boolean;
}

/** Who a client takes for the host, and the election that chose it. */
export interface HostView {
  readonly id: string;
  /** Counts elections; a later election overrules an earlier one. */
  readonly term: number;
}

/** Whether `a` overrules `b`: the higher term, then the lower id. */
function overrules(a: HostView, b: HostView): boolean {
  return a.term > b.term || (a.term === b.term && a.id < b.id);
}

/** Whichever of the view held and the view heard overrules the other. */
export function adopt(
  current: HostView | undefined,
  heard: HostView | null,
): HostView | undefined {
  if (heard === null) return current;
  return current === undefined || overrules(heard, current) ? heard : current;
}

/**
 * The lowest active id, or the lowest id of all when none is active. Hidden pages throttle
 * their timers, so a hidden player is chosen only when no one else can be.
 */
function choose(candidates: readonly [Candidate, ...Candidate[]]): string {
  let best = candidates[0];
  for (const candidate of candidates) {
    if (
      (candidate.active && !best.active) ||
      (candidate.active === best.active && candidate.id < best.id)
    )
      best = candidate;
  }
  return best.id;
}

/**
 * The view to hold once presence has settled. The current host stays while it is active,
 * or while it is still a candidate and no one is active; otherwise a new election chooses
 * one a term later. With no view yet, the first election is term 0.
 */
export function elect(
  current: HostView | undefined,
  candidates: readonly [Candidate, ...Candidate[]],
): HostView {
  if (current !== undefined) {
    const host = candidates.find((candidate) => candidate.id === current.id);
    const anyActive = candidates.some((candidate) => candidate.active);
    if (host !== undefined && (host.active || !anyActive)) return current;
  }
  return {
    id: choose(candidates),
    term: current === undefined ? 0 : current.term + 1,
  };
}
