/** Room tuning for tests, in real milliseconds. */
export const testRoomConfig = {
  sendHz: 15,
  entityHz: 10,
  heartbeatMs: 1000,
  presence: { awayAfterMs: 3500, goneSilentMs: 30_000, goneHiddenMs: 180_000 },
} as const;

interface Interval {
  readonly ms: number;
  readonly fn: () => void;
  next: number;
}

/** A clock that moves only when told to, running its intervals as it passes them. */
export function createManualClock() {
  let time = 0;
  const intervals = new Set<Interval>();

  function due(until: number): Interval | null {
    let first: Interval | null = null;
    for (const interval of intervals) {
      if (
        interval.next <= until &&
        (first === null || interval.next < first.next)
      )
        first = interval;
    }
    return first;
  }

  return {
    now: () => time,
    every(ms: number, fn: () => void): () => void {
      const interval = { ms, fn, next: time + ms };
      intervals.add(interval);
      return () => {
        intervals.delete(interval);
      };
    },
    /** Moves to `until`, running each interval due on the way in time order. */
    advance(until: number): void {
      for (let next = due(until); next !== null; next = due(until)) {
        time = next.next;
        next.next += next.ms;
        next.fn();
      }
      time = until;
    },
    /** Moves to `until` as a stalled page does: each interval that came due runs once, there. */
    stall(until: number): void {
      time = until;
      for (const interval of [...intervals]) {
        if (interval.next > until) continue;
        interval.next = until + interval.ms;
        interval.fn();
      }
    },
    /** Intervals still running. */
    running: (): number => intervals.size,
  };
}
