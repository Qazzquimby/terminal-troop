import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";

type Handlers = Parameters<Transport["join"]>[1];

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

/** A payload as it arrives after travelling as JSON, as over the real transport. */
const overJson = (payload: unknown): unknown =>
  payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));

/**
 * Transports that deliver to every other member of the same room, synchronously, each payload
 * through JSON.
 */
export function createHub() {
  const members = new Map<string, { room: string; handlers: Handlers }>();
  /** While set, members hear only those in their own group; members in no group hear everyone. */
  let groups: Map<string, number> | null = null;
  const hears = (from: string, to: string): boolean =>
    groups === null || groups.get(from) === groups.get(to);

  function transport(name: string, log: string[]) {
    let held: {
      resolve: () => void;
      reject: (error: Error) => void;
    } | null = null;
    let holdNext = false;

    const port: Transport = {
      label: "memory",
      async join(room, handlers) {
        members.delete(name);
        if (holdNext) {
          holdNext = false;
          await new Promise<void>((resolve, reject) => {
            held = { resolve, reject };
          });
        }
        members.set(name, { room, handlers });
      },
      leave() {
        log.push("transport leave");
        members.delete(name);
        return Promise.resolve();
      },
      send(event, payload) {
        if (event !== NetEvent.STATE && event !== NetEvent.HEARTBEAT)
          log.push(`send ${event}`);
        const self = members.get(name);
        if (self === undefined) return Promise.resolve();
        for (const [other, member] of members) {
          if (other !== name && member.room === self.room && hears(name, other))
            member.handlers[event]?.(overJson(payload));
        }
        return Promise.resolve();
      },
    };
    return {
      port,
      /** The next join waits until the returned control settles it. */
      holdNextJoin() {
        holdNext = true;
        return {
          resolve() {
            held?.resolve();
          },
          reject(error: Error) {
            held?.reject(error);
          },
        };
      },
    };
  }

  /** A bare member of `room` that records what reaches it. */
  function listener(room: string) {
    const heard: { event: string; payload: unknown }[] = [];
    const handlers: Handlers = {};
    for (const event of Object.values(NetEvent)) {
      handlers[event] = (payload) => heard.push({ event, payload });
    }
    members.set("listener", { room, handlers });
    const send = (event: NetEvent, payload: unknown): void => {
      for (const [other, member] of members) {
        if (other !== "listener" && member.room === room)
          member.handlers[event]?.(payload);
      }
    };
    return { heard, send };
  }

  return {
    transport,
    listener,
    inRoom: (name: string) => members.has(name),
    /** Splits the members into `sides` that hear only each other, until `heal`. */
    partition(...sides: string[][]) {
      groups = new Map(
        sides.flatMap((side, index) =>
          side.map((name) => [name, index] as const),
        ),
      );
    },
    heal() {
      groups = null;
    },
  };
}
