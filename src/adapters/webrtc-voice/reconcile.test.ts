import { describe, expect, test } from "vitest";
import type { SignalMessage } from "./signal.js";
import {
  connDecision,
  createPendingSignals,
  diffPeers,
  nextBackoff,
} from "./reconcile.js";

const ME = "player-b";
const PEER = "player-a";
const SDP = "v=0\r\n";
const LIMITS = { cap: 4, ttlMs: 1000 };
const BACKOFF = { firstMs: 100, maxMs: 1000 };

function offer(conn?: string, from = PEER): SignalMessage {
  return { from, to: ME, conn, description: { type: "offer", sdp: SDP } };
}

function answer(conn?: string): SignalMessage {
  return {
    from: PEER,
    to: ME,
    conn,
    description: { type: "answer", sdp: SDP },
  };
}

function candidate(conn?: string, index = 0, from = PEER): SignalMessage {
  return {
    from,
    to: ME,
    conn,
    candidate: {
      candidate: `candidate:${String(index)} 1 udp 1 192.0.2.1 5000 typ host`,
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  };
}

function ready(conn: string): SignalMessage {
  return { from: PEER, to: ME, conn, ready: true };
}

describe("diffPeers", () => {
  test("a peer to redo is hung up on and connected again", () => {
    expect(diffPeers(["a", "b"], new Set(["a", "b"]), new Set(["a"]))).toEqual({
      added: ["a"],
      removed: ["a"],
    });
  });

  test("a peer to redo that is not held, or not wanted, is only added or only removed", () => {
    expect(diffPeers(["b"], new Set(["a"]), new Set(["a", "b"]))).toEqual({
      added: ["a"],
      removed: ["b"],
    });
  });

  test("adds the new ids and removes the dropped ones", () => {
    expect(diffPeers(["a", "b"], new Set(["b", "c"]))).toEqual({
      added: ["c"],
      removed: ["a"],
    });
  });

  test("an unchanged set needs nothing", () => {
    expect(diffPeers(["a", "b"], new Set(["b", "a"]))).toEqual({
      added: [],
      removed: [],
    });
  });

  test("from nothing, every id is added; to nothing, every id is removed", () => {
    expect(diffPeers([], new Set(["a", "b"]))).toEqual({
      added: ["a", "b"],
      removed: [],
    });
    expect(diffPeers(new Set(["a", "b"]).keys(), new Set())).toEqual({
      added: [],
      removed: ["a", "b"],
    });
  });
});

describe("connDecision", () => {
  test("a message from the known connection is accepted", () => {
    for (const message of [
      offer("x"),
      answer("x"),
      candidate("x"),
      ready("x"),
    ]) {
      expect(connDecision("x", message)).toEqual({
        kind: "accept",
        remoteConn: "x",
      });
    }
  });

  test("an offer or ready from a new connection replaces ours", () => {
    expect(connDecision("x", offer("y"))).toEqual({
      kind: "replace",
      remoteConn: "y",
    });
    expect(connDecision("x", ready("y"))).toEqual({
      kind: "replace",
      remoteConn: "y",
    });
  });

  test("candidates from a stale connection are dropped", () => {
    expect(connDecision("x", candidate("y"))).toEqual({ kind: "drop" });
  });

  test("an answer from a new connection is taken, and names it", () => {
    expect(connDecision("x", answer("y"))).toEqual({
      kind: "accept",
      remoteConn: "y",
    });
  });

  test("while the other end is unknown, an offer, answer or ready names it", () => {
    for (const message of [offer("y"), answer("y"), ready("y")]) {
      expect(connDecision(null, message)).toEqual({
        kind: "accept",
        remoteConn: "y",
      });
    }
  });

  test("while the other end is unknown, a candidate is accepted without naming it", () => {
    expect(connDecision(null, candidate("y"))).toEqual({
      kind: "accept",
      remoteConn: null,
    });
  });

  test("a message without a connection name never replaces", () => {
    for (const known of ["x", null]) {
      for (const message of [offer(), answer(), candidate()]) {
        expect(connDecision(known, message)).toEqual({
          kind: "accept",
          remoteConn: known,
        });
      }
    }
  });
});

describe("pending signals", () => {
  test("an offer and its candidates replay in order", () => {
    const pending = createPendingSignals(LIMITS);
    const held = [offer("x"), candidate("x", 1), candidate("x", 2)];
    held.forEach((message, index) => {
      pending.hold(message, index * 100);
    });
    expect(pending.take(PEER, 1000)).toEqual(held);
  });

  test("taking empties the queue", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.take(PEER, 0);
    expect(pending.take(PEER, 0)).toEqual([]);
    expect(pending.size(0)).toBe(0);
  });

  test("a ready is held like an offer", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(ready("x"), 0);
    expect(pending.take(PEER, 0)).toEqual([ready("x")]);
  });

  test("candidates and answers with no offer before them are dropped", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(candidate("x"), 0);
    pending.hold(answer("x"), 0);
    expect(pending.size(0)).toBe(0);
    expect(pending.take(PEER, 0)).toEqual([]);
  });

  test("a newer offer starts the queue over", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(candidate("x"), 10);
    pending.hold(offer("y"), 20);
    pending.hold(candidate("y"), 30);
    expect(pending.take(PEER, 40)).toEqual([offer("y"), candidate("y")]);
  });

  test("candidates from another connection than the held offer are dropped", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(candidate("y"), 10);
    pending.hold(candidate(undefined, 1), 20);
    expect(pending.take(PEER, 30)).toEqual([
      offer("x"),
      candidate(undefined, 1),
    ]);
  });

  test("an answer after an offer is not held", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(answer("x"), 10);
    expect(pending.take(PEER, 20)).toEqual([offer("x")]);
  });

  test("a queue expires after its time to live", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(candidate("x"), LIMITS.ttlMs - 1);
    expect(pending.size(LIMITS.ttlMs)).toBe(1);
    expect(pending.take(PEER, LIMITS.ttlMs + 1)).toEqual([]);
  });

  test("expired queues are pruned as new signals arrive", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x", "player-c"), 0);
    pending.hold(offer("x"), LIMITS.ttlMs + 1);
    expect(pending.size(LIMITS.ttlMs + 1)).toBe(1);
    expect(pending.take("player-c", LIMITS.ttlMs + 1)).toEqual([]);
  });

  test("a candidate after expiry does not revive the queue", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(candidate("x"), LIMITS.ttlMs + 1);
    expect(pending.take(PEER, LIMITS.ttlMs + 1)).toEqual([]);
  });

  test("a queue holds at most its cap, keeping the oldest", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    for (let index = 0; index < LIMITS.cap + 10; index++) {
      pending.hold(candidate("x", index), 1);
    }
    const held = pending.take(PEER, 2);
    expect(held).toHaveLength(LIMITS.cap);
    expect(held[0]).toEqual(offer("x"));
    expect(held.at(-1)).toEqual(candidate("x", LIMITS.cap - 2));
  });

  test("each sender has its own queue", () => {
    const pending = createPendingSignals(LIMITS);
    pending.hold(offer("x"), 0);
    pending.hold(offer("z", "player-c"), 0);
    pending.hold(candidate("z", 0, "player-c"), 0);
    expect(pending.take(PEER, 0)).toEqual([offer("x")]);
    expect(pending.take("player-c", 0)).toEqual([
      offer("z", "player-c"),
      candidate("z", 0, "player-c"),
    ]);
  });
});

describe("retry backoff", () => {
  test("starts at the first wait and doubles", () => {
    const first = nextBackoff(null, BACKOFF);
    expect(first).toBe(BACKOFF.firstMs);
    expect(nextBackoff(first, BACKOFF)).toBe(first * 2);
  });

  test("stops growing at the cap", () => {
    let wait = nextBackoff(null, BACKOFF);
    for (let attempt = 0; attempt < 20; attempt++)
      wait = nextBackoff(wait, BACKOFF);
    expect(wait).toBe(BACKOFF.maxMs);
  });
});
