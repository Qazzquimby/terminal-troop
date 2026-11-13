import { z } from "zod";
import { NetEvent, unbatch } from "../net/index.js";
import type { Transport } from "../net/index.js";
import type { Session } from "../sim/index.js";

type Handlers = Parameters<Transport["join"]>[1];

/** Room tuning for tests, in real milliseconds. */
export const testRoomConfig = {
  sendHz: 15,
  fullSnapshotMs: 5000,
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

/** `value` to the tenth of a pixel that positions travel at. */
export const tenth = (value: number): number => Math.round(value * 10) / 10;

/** A content event as it travels: its entry and key. */
const Addressed = z.looseObject({ content: z.string(), event: z.string() });

/** Where a content message is addressed, as `entry.key`; null for anything else. */
export function addressOf(message: unknown): string | null {
  const parsed = Addressed.safeParse(message);
  return parsed.success ? `${parsed.data.content}.${parsed.data.event}` : null;
}

/** What kicks travel to the host as, and what an action the host applied sends everyone. */
export const KICK = "move/kick.kick";
export const EFFECTS = "core/actions.effects";

/**
 * Sends the host the action at `address`, as `entry.name`, with `input`, as a tampered client
 * could: past its own client's checks, and predicting nothing. Numbered past its latest action.
 */
export function forgeAction(
  game: Session,
  address: string,
  input: unknown,
): void {
  const dot = address.lastIndexOf(".");
  game.outbox.push({
    content: address.slice(0, dot),
    event: address.slice(dot + 1),
    route: "host",
    to: null,
    payload: { action: ++game.lastAction, input },
  });
}

/** The messages one broadcast carries: those of a batch, or the one sent. */
export const messages = (
  event: NetEvent,
  payload: unknown,
): { event: NetEvent; payload: unknown }[] =>
  event === NetEvent.BATCH ? unbatch(payload) : [{ event, payload }];

/** A message on its way to one member, sent while the hub was held. */
interface Pending {
  readonly to: string;
  readonly deliver: () => void;
}

/**
 * Transports that deliver to every other member of the same room, each payload through JSON:
 * synchronously, or while held, in the order sent once released.
 */
export function createHub() {
  const members = new Map<string, { room: string; handlers: Handlers }>();
  /** While set, what is sent waits here instead of arriving. */
  let pending: Pending[] | null = null;
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
        for (const message of messages(event, payload)) {
          if (
            message.event !== NetEvent.STATE &&
            message.event !== NetEvent.HEARTBEAT
          )
            log.push(`send ${message.event}`);
        }
        const self = members.get(name);
        if (self === undefined) return Promise.resolve();
        for (const [other, member] of members) {
          if (
            other === name ||
            member.room !== self.room ||
            !hears(name, other)
          )
            continue;
          const wire = overJson(payload);
          const deliver = () => member.handlers[event]?.(wire);
          if (pending === null) deliver();
          else pending.push({ to: other, deliver });
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
      handlers[event] = (payload) => heard.push(...messages(event, payload));
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
    /** Holds back everything sent from here on, until released. */
    hold() {
      pending ??= [];
    },
    /** Delivers what is held for member `to`, in the order it was sent, and goes on holding. */
    release(to: string) {
      const held = pending ?? [];
      pending = held.filter((message) => message.to !== to);
      for (const message of held) if (message.to === to) message.deliver();
    },
    /** Loses what is held for member `to`, and goes on holding. */
    drop(to: string) {
      pending = (pending ?? []).filter((message) => message.to !== to);
    },
    /** Delivers everything held, in the order sent, and stops holding. */
    flush() {
      const held = pending ?? [];
      pending = null;
      for (const message of held) message.deliver();
    },
  };
}

/**
 * A transport whose sends arrive `delayMs()` after they are sent, in the order sent, and that
 * counts the corrections (forced moves that jump rather than slide), kicks and kicks shown it
 * sends. While held, what is sent waits until released, then arrives all at once.
 */
export function delayed(port: Transport, delayMs: () => number) {
  const queue: { at: number | null; send: () => void }[] = [];
  let last = 0;
  let held = false;
  const counts = { corrections: 0, kicks: 0, shown: 0 };
  const send: Transport["send"] = (event, payload) => {
    for (const message of messages(event, payload)) {
      if (message.event !== NetEvent.CONTENT) continue;
      const json = JSON.stringify(message.payload);
      if (json.includes('"core/position"') && !json.includes('"slide"'))
        counts.corrections++;
      const address = addressOf(message.payload);
      if (address === KICK) counts.kicks++;
      if (address === EFFECTS) counts.shown++;
    }
    queue.push({ at: null, send: () => void port.send(event, payload) });
    return Promise.resolve();
  };
  /** Delivers what is due by `now`. */
  const flush = (now: number): void => {
    while (queue[0]?.at != null && queue[0].at <= now) queue.shift()?.send();
  };
  /** Sends what is queued at once, then leaves, so that leaving is heard. */
  const leave: Transport["leave"] = () => {
    for (const item of queue) item.at ??= last;
    flush(Infinity);
    return port.leave();
  };
  return {
    port: { ...port, send, leave },
    counts,
    flush,
    /** Stamps what was sent since last time, unless held, as sent at `now`. */
    stamp(now: number): void {
      if (held) return;
      for (const item of queue)
        if (item.at === null) {
          last = Math.max(last, now + delayMs());
          item.at = last;
        }
    },
    hold(): void {
      held = true;
    },
    /** Delivers everything held, and what is due, at `now`. */
    release(now: number): void {
      held = false;
      for (const item of queue) item.at ??= now;
      flush(now);
    },
  };
}
