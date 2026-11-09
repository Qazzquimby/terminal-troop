import { describe, expect, test } from "vitest";
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
        if (event !== NetEvent.STATE) log.push(`send ${event}`);
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

/** Voice whose rooms record each call into `log`. */
function recordingVoice(log: string[]): Voice {
  const voice = createNullVoice({ mode: "open", muted: false, volume: 1 });
  return {
    ...voice,
    join: () => ({
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
    }),
  };
}

function setup(hub = createHub(), id = "me") {
  const log: string[] = [];
  const transport = hub.transport(id, log);
  let time = 0;
  let changes = 0;
  const room = createRoom({
    localId: id,
    world: "dev",
    transport: transport.port,
    voice: recordingVoice(log),
    sfx: {
      ...testSfx(),
      stopAll() {
        log.push("sfx stop");
      },
    },
    scope: createScope(),
    clock: { now: () => time },
    config: { sendHz: 15, staleS: 15 },
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
    at: (now: number) => {
      time = now;
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
  test("leaving says BYE, then hangs up voice, then closes the channel, then stops sounds", async () => {
    const { room, log } = setup();
    await room.join("ABC", "ME");
    log.length = 0;
    await room.leave();
    expect(log).toEqual([
      "send bye",
      "voice leave",
      "transport leave",
      "sfx stop",
    ]);
  });

  test("switching rooms leaves the old one in the same order before joining", async () => {
    const { room, log } = setup();
    await room.join("ABC", "ME");
    log.length = 0;
    await room.join("XYZ", "ME");
    expect(log.slice(0, 4)).toEqual([
      "send bye",
      "voice leave",
      "transport leave",
      "sfx stop",
    ]);
    expect(log.slice(4)).toContain("send hello");
    expect(joined(room).code).toBe("XYZ");
  });
});

describe("players and voice", () => {
  async function pair() {
    const a = setup(createHub(), "a");
    const b = setup(a.hub, "b");
    await a.room.join("ABC", "A");
    await b.room.join("ABC", "B");
    return { a, b };
  }

  test("a HELLO and the forced STATE that follows it introduce both sides", async () => {
    const { a, b } = await pair();
    expect(joined(a.room).session.players.get("b")?.name).toBe("B");
    expect(joined(b.room).session.players.get("a")?.name).toBe("A");
  });

  test("a new player gets its mix before it joins the voice peers", async () => {
    const { a } = await pair();
    const mix = a.log.indexOf("mix b");
    expect(mix).toBeGreaterThan(-1);
    expect(a.log.indexOf("peers b")).toBeGreaterThan(mix);
  });

  test("BYE removes the player and shrinks the voice peers", async () => {
    const { a, b } = await pair();
    const before = a.changes();
    await b.room.leave();
    expect(joined(a.room).session.players.has("b")).toBe(false);
    expect(a.log.at(-1)).toBe("peers ");
    expect(a.changes()).toBe(before + 1);
  });

  test("a player silent for longer than the stale time is dropped", async () => {
    const { a } = await pair();
    a.at(15_000);
    a.room.frame(15_000);
    expect(joined(a.room).session.players.has("b")).toBe(true);
    a.at(15_001);
    a.room.frame(15_001);
    expect(joined(a.room).session.players.has("b")).toBe(false);
    expect(a.log.at(-1)).toBe("peers ");
  });

  test("a STATE outside the room's free floor is ignored", async () => {
    const { room, hub } = setup();
    await room.join("ABC", "ME");
    const other = hub.listener("dev:ABC");
    other.send(NetEvent.STATE, { id: "x", name: "X", x: 0, y: 0, aim: 0 });
    expect(joined(room).session.players.has("x")).toBe(false);
    expect(room.lastHeard("x")).toBeUndefined();
  });

  test("a STATE records when the player was heard", async () => {
    const { room, hub, at } = setup();
    await room.join("ABC", "ME");
    const other = hub.listener("dev:ABC");
    const session = joined(room).session;
    const spot = randomFreePosition(session.world, session.local.radius);
    at(500);
    other.send(NetEvent.STATE, { id: "x", name: "X", ...spot, aim: 0 });
    expect(room.lastHeard("x")).toBe(500);
  });
});

describe("state sends", () => {
  async function watched() {
    const ctx = setup();
    await ctx.room.join("ABC", "ME");
    const other = ctx.hub.listener("dev:ABC");
    const states = () =>
      other.heard.filter((message) => message.event === NetEvent.STATE).length;
    return { ...ctx, other, states };
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
    const { room, other, states, at } = await watched();
    room.frame(SEND_GAP + 1);
    at(SEND_GAP + 2);
    other.send(NetEvent.HELLO, { id: "x" });
    expect(states()).toBe(2);
    const last = other.heard.at(-1);
    expect(last?.payload).toEqual(playerState(joined(room).session.local));
  });

  test("becoming visible again says HELLO with a forced state", async () => {
    const { room, other, states } = await watched();
    room.setHidden(true);
    expect(other.heard).toEqual([]);
    room.setHidden(false);
    expect(other.heard.map((message) => message.event)).toEqual([
      NetEvent.HELLO,
      NetEvent.STATE,
    ]);
    expect(states()).toBe(1);
  });
});
