import type { SignalMessage } from "./signal.js";
import { opensNegotiation } from "./signal.js";

/**
 * The peers to connect to and to hang up on to get from `current` to `desired`. Peers in
 * `redo` that are both held and wanted are hung up on and connected again.
 */
export function diffPeers(
  current: Iterable<string>,
  desired: ReadonlySet<string>,
  redo: ReadonlySet<string> = new Set(),
): { added: string[]; removed: string[] } {
  const have = new Set(current);
  const again = (id: string): boolean => redo.has(id) && have.has(id);
  return {
    added: [...desired].filter((id) => !have.has(id) || again(id)),
    removed: [...have].filter((id) => !desired.has(id) || redo.has(id)),
  };
}

/**
 * What to do with a message for a peer that has a connection whose other end is
 * `remoteConn` (null while unknown):
 * - accept: hand it to the connection, which now talks to `remoteConn`
 * - replace: the other side opened a new connection; open one to match it, then hand it over
 * - drop: it belongs to a connection that is gone
 */
export type ConnDecision =
  | { kind: "accept"; remoteConn: string | null }
  | { kind: "replace"; remoteConn: string }
  | { kind: "drop" };

/**
 * Offers and readies name the connection the other side negotiates on, so a new name means a
 * new connection. An answer replies to our own offer from whichever connection took it, so it
 * renames without replacing. A message without a name comes from a client that sends none,
 * and is always accepted.
 */
export function connDecision(
  remoteConn: string | null,
  message: SignalMessage,
): ConnDecision {
  const { conn } = message;
  if (conn === undefined || conn === remoteConn) {
    return { kind: "accept", remoteConn };
  }
  if ("candidate" in message) {
    return remoteConn === null
      ? { kind: "accept", remoteConn }
      : { kind: "drop" };
  }
  if (remoteConn !== null && opensNegotiation(message)) {
    return { kind: "replace", remoteConn: conn };
  }
  return { kind: "accept", remoteConn: conn };
}

/** How many signals are held for one peer, and for how long after the first. */
export interface PendingLimits {
  cap: number;
  ttlMs: number;
}

interface Held {
  since: number;
  conn: string | undefined;
  messages: SignalMessage[];
}

/**
 * Signals from players voice is not connecting to yet. An offer or a ready starts a fresh
 * queue for its sender, candidates on the same connection join it, and everything else is
 * dropped. A queue expires `ttlMs` after it starts and holds at most `cap` messages.
 */
export function createPendingSignals(limits: PendingLimits) {
  const queues = new Map<string, Held>();

  function live(held: Held, now: number): boolean {
    return now - held.since <= limits.ttlMs;
  }

  function prune(now: number): void {
    queues.forEach((held, id) => {
      if (!live(held, now)) queues.delete(id);
    });
  }

  return {
    hold(message: SignalMessage, now: number): void {
      prune(now);
      if (opensNegotiation(message)) {
        queues.set(message.from, {
          since: now,
          conn: message.conn,
          messages: [message],
        });
        return;
      }
      const held = queues.get(message.from);
      if (held === undefined || !("candidate" in message)) return;
      const sameConn =
        held.conn === undefined ||
        message.conn === undefined ||
        held.conn === message.conn;
      if (sameConn && held.messages.length < limits.cap) {
        held.messages.push(message);
      }
    },
    /** Removes and returns what is held for `id`, oldest first; nothing once expired. */
    take(id: string, now: number): SignalMessage[] {
      const held = queues.get(id);
      queues.delete(id);
      return held !== undefined && live(held, now) ? held.messages : [];
    },
    /** How many peers have signals held. */
    size(now: number): number {
      prune(now);
      return queues.size;
    },
  };
}

/** Waits between attempts to reconnect a peer whose connection failed. */
export interface Backoff {
  firstMs: number;
  maxMs: number;
}

/** The wait before the next attempt, given the wait before the last one (null if none). */
export function nextBackoff(
  previousMs: number | null,
  backoff: Backoff,
): number {
  if (previousMs === null) return backoff.firstMs;
  return Math.min(previousMs * 2, backoff.maxMs);
}
