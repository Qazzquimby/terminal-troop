import { describe, expect, test } from "vitest";
import {
  createManualClock,
  testRoomConfig,
} from "../integration/room-helpers.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createScope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { playerState, randomFreePosition } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import type { Voice } from "../voice/index.js";
import { createRoom } from "./room.js";
import type { Room, RoomState } from "./room.js";

type Handlers = Parameters<Transport["join"]>[1];

const SEND_GAP = 1000 / 15;

/** Lets pending promise callbacks run, so a held join is waiting on its gate. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Transports that deliver to every other member of the same room, synchronously. */
function createHub() {
  const members = new Map<string, { room: string; handlers: Handlers }>();

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
          if (other !== name && member.room === self.room)
            member.handlers[event]?.(payload);
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
  };
}

/**
 * Voice whose rooms record each call into `log`, and hand their failure callback to
 * `failures`.
 */
function recordingVoice(
  log: string[],
  failures: { peerFailed: (id: string) => void }[],
): Voice {
  const voice = createNullVoice({ mode: "open", muted: false, volume: 1 });
  return {
    ...voice,
    join: (_id, _send, events) => {
      failures.push(events);
      return {
        receive: () => undefined,
        setPeers(ids) {
          log.push(`peers ${[...ids].sort().join(",")}`);
        },
        setPeerMix(id) {
          log.push(`mix ${id}`);
        },
        leave() {
          log.push("voice leave");
        },
      };
    },
  };
}

function setup(hub = createHub(), id = "me", clock = createManualClock()) {
  const log: string[] = [];
  const failures: { peerFailed: (id: string) => void }[] = [];
  const transport = hub.transport(id, log);
  let changes = 0;
  const room = createRoom({
    localId: id,
    world: "dev",
    transport: transport.port,
    voice: recordingVoice(log, failures),
    sfx: {
      ...testSfx(),
      stopAll() {
        log.push("sfx stop");
      },
    },
    scope: createScope(),
    clock: {
      now: clock.now,
      every(ms, fn) {
        const stop = clock.every(ms, fn);
        return () => {
          log.push("timer stop");
          stop();
        };
      },
    },
    config: testRoomConfig,
    sim: testSimConfig,
    falloff: { full: 100, silent: 600, pan: 300 },
    onChange() {
      changes++;
    },
    onPeerFailed: () => undefined,
  });
  return {
    hub,
    room,
    log,
    transport,
    clock,
    /** Reports that the voice connection to `id` failed. */
    failPeer: (id: string) => {
      failures.at(-1)?.peerFailed(id);
    },
    changes: () => changes,
  };
}

function joined(room: Room): Extract<RoomState, { kind: "joined" }> {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state;
}

describe("state", () => {
  test("starts in the lobby, connects, then joins", async () => {
    const { room, changes } = setup();
    expect(room.state()).toEqual({ kind: "lobby", error: null });

    const joining = room.join(" abc ", "ME");
    expect(room.state()).toEqual({ kind: "connecting", code: "ABC" });

    expect(await joining).toEqual({ ok: true });
    const state = joined(room);
    expect(state.code).toBe("ABC");
    expect(state.session.local.name).toBe("ME");
    expect(room.state()).toBe(state);
    expect(changes()).toBe(2);
  });

  test("an invalid code in the lobby records the error", async () => {
    const { room } = setup();
    const result = await room.join("x!", "ME");
    expect(result.ok).toBe(false);
    expect(room.state()).toEqual({
      kind: "lobby",
      error: "Room code must be 3–8 letters/numbers.",
    });
  });

  test("an invalid code while joined changes nothing", async () => {
    const { room } = setup();
    await room.join("ABC", "ME");
    const before = room.state();
    expect(await room.join("x!", "ME")).toEqual({
      ok: false,
      error: "Room code must be 3–8 letters/numbers.",
    });
    expect(room.state()).toBe(before);
  });

  test("a join while connecting returns at once and keeps connecting", async () => {
    const { room, transport } = setup();
    const gate = transport.holdNextJoin();
    const first = room.join("ABC", "ME");
    await settle();
    const second = await room.join("XYZ", "ME");
    expect(second.ok).toBe(false);
    expect(room.state()).toEqual({ kind: "connecting", code: "ABC" });
    gate.resolve();
    expect(await first).toEqual({ ok: true });
    expect(joined(room).code).toBe("ABC");
  });

  test("leaving while connecting leaves the channel when the join resolves late", async () => {
    const { room, transport, log, hub } = setup();
    const gate = transport.holdNextJoin();
    const joining = room.join("ABC", "ME");
    await settle();
    await room.leave();
    expect(room.state()).toEqual({ kind: "lobby", error: null });

    gate.resolve();
    const result = await joining;
    expect(result.ok).toBe(false);
    expect(room.state()).toEqual({ kind: "lobby", error: null });
    expect(hub.inRoom("me")).toBe(false);
    expect(log).toEqual(["sfx stop", "transport leave"]);
  });

  test("a rejected join returns to the lobby with the error", async () => {
    const { room, transport, log } = setup();
    const gate = transport.holdNextJoin();
    const joining = room.join("ABC", "ME");
    await settle();
    gate.reject(new Error("Channel refused."));
    expect(await joining).toEqual({ ok: false, error: "Channel refused." });
    expect(room.state()).toEqual({ kind: "lobby", error: "Channel refused." });
    expect(log).toEqual(["sfx stop"]);
  });

  test("leaving a joined room returns to an empty lobby", async () => {
    const { room, hub } = setup();
    await room.join("ABC", "ME");
    await room.leave();
    expect(room.state()).toEqual({ kind: "lobby", error: null });
    expect(hub.inRoom("me")).toBe(false);
  });

  test("a new join clears the last error", async () => {
    const { room } = setup();
    await room.join("x!", "ME");
    await room.join("ABC", "ME");
    expect(joined(room).code).toBe("ABC");
  });
});

describe("disposal", () => {
  test("leaving says BYE, then stops heartbeats, then hangs up voice, then closes the channel, then stops sounds", async () => {
    const { room, log, clock } = setup();
    await room.join("ABC", "ME");
    log.length = 0;
    await room.leave();
    expect(log).toEqual([
      "send bye",
      "timer stop",
      "voice leave",
      "transport leave",
      "sfx stop",
    ]);
    expect(clock.running()).toBe(0);
  });

  test("switching rooms leaves the old one in the same order before joining", async () => {
    const { room, log } = setup();
    await room.join("ABC", "ME");
    log.length = 0;
    await room.join("XYZ", "ME");
    expect(log.slice(0, 5)).toEqual([
      "send bye",
      "timer stop",
      "voice leave",
      "transport leave",
      "sfx stop",
    ]);
    expect(log.slice(5)).toContain("send hello");
    expect(joined(room).code).toBe("XYZ");
  });
});

/** A room joined as "me" with a bare listener "x" in it, and a free spot for x to stand. */
async function withListener() {
  const ctx = setup();
  await ctx.room.join("ABC", "ME");
  const other = ctx.hub.listener("dev:ABC");
  const session = joined(ctx.room).session;
  const spot = randomFreePosition(session.world, session.local.radius);
  const sendState = () => {
    other.send(NetEvent.STATE, { id: "x", name: "X", ...spot, aim: 0 });
  };
  const beat = (hidden: boolean) => {
    other.send(NetEvent.HEARTBEAT, { id: "x", hidden });
  };
  const hasX = () => session.players.has("x");
  return { ...ctx, other, session, spot, sendState, beat, hasX };
}

describe("players and voice", () => {
  async function pair() {
    const clock = createManualClock();
    const a = setup(createHub(), "a", clock);
    const b = setup(a.hub, "b", clock);
    await a.room.join("ABC", "A");
    await b.room.join("ABC", "B");
    return { a, b, clock };
  }

  test("a HELLO and the forced STATE that follows it introduce both sides", async () => {
    const { a, b } = await pair();
    expect(joined(a.room).session.players.get("b")?.name).toBe("B");
    expect(joined(b.room).session.players.get("a")?.name).toBe("A");
    expect(a.room.presenceOf("b")?.kind).toBe("present");
  });

  test("a new player gets its mix before it joins the voice peers", async () => {
    const { a } = await pair();
    const mix = a.log.indexOf("mix b");
    expect(mix).toBeGreaterThan(-1);
    expect(a.log.indexOf("peers b")).toBeGreaterThan(mix);
  });

  test("BYE removes the player and shrinks the voice peers at once", async () => {
    const { a, b } = await pair();
    const before = a.changes();
    await b.room.leave();
    expect(joined(a.room).session.players.has("b")).toBe(false);
    expect(a.room.presenceOf("b")).toBeUndefined();
    expect(a.log.at(-1)).toBe("peers ");
    expect(a.changes()).toBe(before + 1);
  });

  test("heartbeats keep both sides present without any STATE", async () => {
    const { a, b, clock } = await pair();
    clock.advance(60_000);
    expect(a.room.presenceOf("b")).toEqual({
      kind: "present",
      lastHeard: 60_000,
    });
    expect(b.room.presenceOf("a")?.kind).toBe("present");
  });

  test("a STATE outside the room's free floor adds no player", async () => {
    const { other, log, hasX } = await withListener();
    other.send(NetEvent.STATE, { id: "x", name: "X", x: 0, y: 0, aim: 0 });
    expect(hasX()).toBe(false);
    expect(log).not.toContain("peers x");
  });

  test("a STATE records when the player was heard", async () => {
    const { room, clock, sendState } = await withListener();
    clock.advance(500);
    sendState();
    expect(room.presenceOf("x")).toEqual({ kind: "present", lastHeard: 500 });
  });
});

describe("presence", () => {
  test("a peer sending only hidden heartbeats for 60s stays a voice peer", async () => {
    const { room, log, clock, sendState, beat, hasX } = await withListener();
    sendState();
    expect(log.at(-1)).toBe("peers x");
    beat(true);
    log.length = 0;
    for (let second = 1; second <= 60; second++) {
      clock.advance(second * 1000);
      beat(true);
    }
    expect(room.presenceOf("x")).toEqual({
      kind: "away",
      lastHeard: 60_000,
      hidden: true,
    });
    expect(hasX()).toBe(true);
    expect(log.filter((entry) => entry.startsWith("peers"))).toEqual([]);
  });

  test("silence makes a player away, then gone, which removes it", async () => {
    const { room, log, clock, sendState, hasX, changes } = await withListener();
    sendState();
    clock.advance(3000);
    expect(room.presenceOf("x")?.kind).toBe("present");
    const before = changes();
    clock.advance(4000);
    expect(room.presenceOf("x")?.kind).toBe("away");
    expect(changes()).toBe(before + 1);
    expect(hasX()).toBe(true);
    expect(log.at(-1)).not.toBe("peers ");

    clock.advance(29_000);
    expect(hasX()).toBe(true);
    clock.advance(30_000);
    expect(room.presenceOf("x")).toBeUndefined();
    expect(hasX()).toBe(false);
    expect(log.at(-1)).toBe("peers ");
  });

  test("BYE tombstones the player until it says HELLO", async () => {
    const { room, other, log, sendState, beat, hasX } = await withListener();
    sendState();
    other.send(NetEvent.BYE, { id: "x" });
    expect(hasX()).toBe(false);
    expect(log.at(-1)).toBe("peers ");

    sendState();
    beat(false);
    expect(hasX()).toBe(false);
    expect(room.presenceOf("x")).toBeUndefined();

    other.send(NetEvent.HELLO, { id: "x" });
    sendState();
    expect(hasX()).toBe(true);
    expect(log.at(-1)).toBe("peers x");
  });

  test("a failed voice connection drops an away player but not a present one", async () => {
    const { room, clock, failPeer, sendState, hasX } = await withListener();
    sendState();
    failPeer("x");
    expect(room.presenceOf("x")?.kind).toBe("present");
    clock.advance(4000);
    failPeer("x");
    expect(room.presenceOf("x")).toBeUndefined();
    expect(hasX()).toBe(false);
  });

  test("the pulse sends a heartbeat every second", async () => {
    const { other, clock } = await withListener();
    const beats = () =>
      other.heard.filter((message) => message.event === NetEvent.HEARTBEAT);
    clock.advance(999);
    expect(beats()).toEqual([]);
    clock.advance(3000);
    expect(beats().map((message) => message.payload)).toEqual([
      { id: "me", hidden: false },
      { id: "me", hidden: false },
      { id: "me", hidden: false },
    ]);
  });

  test("the pulse keeps beating while hidden, with the hidden flag", async () => {
    const { room, other, clock } = await withListener();
    room.setHidden(true);
    clock.advance(2000);
    expect(other.heard.map((message) => message.payload)).toEqual([
      { id: "me", hidden: true },
      { id: "me", hidden: true },
      { id: "me", hidden: true },
    ]);
  });
});

describe("state sends", () => {
  async function watched() {
    const ctx = await withListener();
    const states = () =>
      ctx.other.heard.filter((message) => message.event === NetEvent.STATE)
        .length;
    return { ...ctx, states };
  }

  test("frames send state at most sendHz times a second", async () => {
    const { room, states } = await watched();
    room.frame(1);
    expect(states()).toBe(0);
    room.frame(SEND_GAP + 1);
    expect(states()).toBe(1);
    room.frame(SEND_GAP + 2);
    expect(states()).toBe(1);
    room.frame(2 * SEND_GAP + 2);
    expect(states()).toBe(2);
  });

  test("a HELLO forces a state send inside the gap", async () => {
    const { room, other, states, clock } = await watched();
    room.frame(SEND_GAP + 1);
    clock.advance(SEND_GAP + 2);
    other.send(NetEvent.HELLO, { id: "x" });
    expect(states()).toBe(2);
    const last = other.heard.at(-1);
    expect(last?.payload).toEqual(playerState(joined(room).session.local));
  });

  test("hiding sends a hidden heartbeat at once", async () => {
    const { room, other } = await watched();
    room.setHidden(true);
    expect(other.heard).toEqual([
      { event: NetEvent.HEARTBEAT, payload: { id: "me", hidden: true } },
    ]);
  });

  test("becoming visible sends a heartbeat at once and a forced STATE on the next frame, and no HELLO", async () => {
    const { room, other, states } = await watched();
    room.frame(SEND_GAP + 1);
    room.setHidden(true);
    other.heard.length = 0;
    room.setHidden(false);
    expect(other.heard).toEqual([
      { event: NetEvent.HEARTBEAT, payload: { id: "me", hidden: false } },
    ]);
    room.frame(SEND_GAP + 2);
    expect(states()).toBe(1);
    expect(other.heard.map((message) => message.event)).not.toContain(
      NetEvent.HELLO,
    );
  });
});

describe("payloads that do not parse are dropped", () => {
  const heard = withListener;

  test("a STATE with a bad field adds no player", async () => {
    const { room, other, session, spot } = await heard();
    other.send(NetEvent.STATE, { id: "x", name: 5, ...spot, aim: 0 });
    expect(session.players.has("x")).toBe(false);
    expect(room.presenceOf("x")).toBeUndefined();
  });

  test("a BYE without an id drops no one", async () => {
    const { other, session, spot } = await heard();
    other.send(NetEvent.STATE, { id: "x", name: "X", ...spot, aim: 0 });
    other.send(NetEvent.BYE, { who: "x" });
    expect(session.players.has("x")).toBe(true);
    other.send(NetEvent.BYE, { id: "x" });
    expect(session.players.has("x")).toBe(false);
  });

  test("a heartbeat without its hidden flag changes no presence", async () => {
    const { room, beat, other } = await heard();
    other.send(NetEvent.HEARTBEAT, { id: "x" });
    expect(room.presenceOf("x")).toBeUndefined();
    beat(true);
    expect(room.presenceOf("x")?.kind).toBe("away");
  });

  test("a HELLO without an id forces no state send", async () => {
    const { other } = await heard();
    other.send(NetEvent.HELLO, null);
    expect(other.heard).toEqual([]);
    other.send(NetEvent.HELLO, { id: "x" });
    expect(other.heard.map((message) => message.event)).toEqual([
      NetEvent.STATE,
    ]);
  });
});

describe("host", () => {
  /** Players a, b and c in one room; a keeps its own clock, so it falls silent unless moved. */
  async function trio() {
    const hub = createHub();
    const clock = createManualClock();
    const a = setup(hub, "a", createManualClock());
    const b = setup(hub, "b", clock);
    const c = setup(hub, "c", clock);
    for (const { room } of [a, b, c]) await room.join("ABC", "P");
    const hosts = (...players: { room: Room }[]) =>
      players.map(({ room }) => room.hostId());
    return { a, b, c, clock, hosts };
  }

  test("is undefined outside a room, and the local player when alone", async () => {
    const { room } = setup();
    expect(room.hostId()).toBeUndefined();
    await room.join("ABC", "ME");
    expect(room.hostId()).toBe("me");
    await room.leave();
    expect(room.hostId()).toBeUndefined();
  });

  test("every player agrees on the lowest id", async () => {
    const { a, b, c, hosts } = await trio();
    expect(hosts(a, b, c)).toEqual(["a", "a", "a"]);
  });

  test("passes to the next lowest id when the host leaves", async () => {
    const { a, b, c, hosts } = await trio();
    await a.room.leave();
    expect(hosts(b, c)).toEqual(["b", "b"]);
  });

  test("passes on when the host falls silent, and returns when it is heard again", async () => {
    const { a, b, c, clock, hosts } = await trio();
    clock.advance(3000);
    expect(hosts(b, c)).toEqual(["a", "a"]);
    clock.advance(4000);
    expect(b.room.presenceOf("a")?.kind).toBe("away");
    expect(hosts(b, c)).toEqual(["b", "b"]);
    a.clock.advance(1000);
    expect(hosts(b, c)).toEqual(["a", "a"]);
  });

  test("passes on when the host times out", async () => {
    const { a, b, c, clock, hosts } = await trio();
    clock.advance(31_000);
    expect(b.room.presenceOf("a")).toBeUndefined();
    expect(hosts(b, c)).toEqual(["b", "b"]);
    expect(a.room.hostId()).toBe("a");
  });

  test("a hidden page is passed over by everyone, itself included, until shown", async () => {
    const { a, b, c, hosts } = await trio();
    a.room.setHidden(true);
    expect(hosts(a, b, c)).toEqual(["b", "b", "b"]);
    a.room.setHidden(false);
    expect(hosts(a, b, c)).toEqual(["a", "a", "a"]);
  });

  test("with every page hidden, the lowest id hosts", async () => {
    const { a, b, c, hosts } = await trio();
    for (const { room } of [a, b, c]) room.setHidden(true);
    expect(hosts(a, b, c)).toEqual(["a", "a", "a"]);
  });

  test("a newcomer passes over a hidden page too", async () => {
    const { a, b, c, hosts } = await trio();
    a.room.setHidden(true);
    const d = setup(a.hub, "d", b.clock);
    await d.room.join("ABC", "D");
    expect(d.room.presenceOf("a")?.kind).toBe("away");
    expect(hosts(a, b, c, d)).toEqual(["b", "b", "b", "b"]);
  });
});
