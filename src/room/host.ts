/** A player the host can be chosen from. */
export interface Candidate {
  readonly id: string;
  /** Heard from recently, with its page visible. */
  readonly active: boolean;
}

/** A remote candidate, with the host view it last sent. */
export interface RemoteCandidate extends Candidate {
  /** Null before it has sent one. */
  readonly view: HostView | null;
}

/** Who a client takes for the host, and the election that chose it. */
export interface HostView {
  readonly id: string;
  /** Counts elections; a later election overrules an earlier one. */
  readonly term: number;
  /**
   * Elected by a client that saw no other active player, so possibly cut off from the room,
   * until another active player is heard holding the same view.
   */
  readonly solo: boolean;
}

/** Whether `a` overrules `b`: a view of the room over a solo one, then the higher term, then the lower id. */
function overrules(a: HostView, b: HostView): boolean {
  if (a.solo !== b.solo) return !a.solo;
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
function choose(candidates: readonly Candidate[], first: Candidate): string {
  let best = first;
  for (const candidate of candidates) {
    if (
      (candidate.active && !best.active) ||
      (candidate.active === best.active && candidate.id < best.id)
    )
      best = candidate;
  }
  return best.id;
}

/** Whether `b` is the same election as `a`: the same host chosen in the same term. */
export function sameElection(a: HostView, b: HostView | null): boolean {
  return b !== null && a.id === b.id && a.term === b.term;
}

/**
 * The view to hold once presence has settled. The current host stays while it is active,
 * or while it is still a candidate and no one is active; otherwise a new election chooses
 * one a term later. With no view yet, the first election is term 0. A solo view stops being
 * solo once an active remote player holds it too.
 */
export function elect(
  current: HostView | undefined,
  local: Candidate,
  remotes: readonly RemoteCandidate[],
): HostView {
  const candidates = [local, ...remotes];
  if (current !== undefined) {
    const host = candidates.find((candidate) => candidate.id === current.id);
    const anyActive = candidates.some((candidate) => candidate.active);
    if (host !== undefined && (host.active || !anyActive)) {
      const shared = remotes.some(
        (remote) => remote.active && sameElection(current, remote.view),
      );
      return current.solo && shared ? { ...current, solo: false } : current;
    }
  }
  return {
    id: choose(candidates, local),
    term: current === undefined ? 0 : current.term + 1,
    solo: !remotes.some((remote) => remote.active),
  };
}
