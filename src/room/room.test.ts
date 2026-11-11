import { describe, expect, test } from "vitest";
import {
  createManualClock,
  testRoomConfig,
} from "../integration/room-helpers.js";
import { testSfx, testSimConfig } from "../integration/sim-config.js";
import { createScope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import {
  applyDamage,
  contentEvent,
  heldItemId,
  heldItemOf,
  playerData,
  playerState,
  randomFreePosition,
  registerEntityType,
  defineEntity,
  defineItem,
  spawnEntity,
  updateSession,
} from "../sim/index.js";
import type { Point, Session, WorldContent } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import type { Voice } from "../voice/index.js";
import { z } from "zod";
import { Health, roomMessages } from "./protocol.js";
import { createRoom } from "./room.js";
import type { Room, RoomState } from "./room.js";

type Handlers = Parameters<Transport["join"]>[1];

const SEND_GAP = 1000 / 15;
const idle = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  select: null,
  use: false,
};
const heartbeat = roomMessages(testSimConfig.player.nameMax)[
  NetEvent.HEARTBEAT
];

/** Lets pending promise callbacks run, so a held join is waiting on its gate. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A payload as it arrives after travelling as JSON, as over the real transport. */
const overJson = (payload: unknown): unknown =>
  payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));

/**
 * Transports that deliver to every other member of the same room, synchronously, each payload
 * through JSON.
 */
function createHub() {
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

/** Three blobs start across the dev square, each drifting right at 20px/s with 10 health, and heard stepping. */
const blobs: WorldContent = {
  name: "entity/blob",
  register(session) {
    registerEntityType(session, "blob", {
      radius: 10,
      maxHealth: 10,
      data: z.object({ steps: z.number().int() }),
      update(entity, data) {
        entity.vx = 20;
        return { steps: data.steps + 1 };
      },
      cue(entity, previous, next, game) {
        if (next.steps > previous.steps)
          void game.sfx.play("step", entity, game.local);
      },
      draw: () => undefined,
    });
  },
  populate(session) {
    for (const x of [100, 400, 700])
      spawnEntity(session, "blob", x, 300, { steps: 0 });
  },
};

/** Bites every player within 40px for 5 each step; none spawn unless a test places one. */
const BITER = "biter";

const biters: WorldContent = {
  name: "entity/biter",
  register(session) {
    registerEntityType(session, BITER, {
      radius: 10,
      maxHealth: 10,
      data: z.object({}),
      update: (_entity, data) => data,
      strikes: (entity, _data, game) =>
        [...game.players.values()]
          .filter(
            (player) =>
              Math.hypot(player.x - entity.x, player.y - entity.y) < 40,
          )
          .map((player) => ({ target: player.id, amount: 5 })),
      draw: () => undefined,
    });
  },
  populate: () => undefined,
};

/**
 * A poke, in every player's second slot from the start: 4 damage to every entity within 30px of
 * a point 20px ahead, at most once per configured cooldown.
 */
const poke = defineItem("poke", (cooldown: number) => ({
  name: "Poke",
  maxStack: 1,
  emoji: "👉",
  starting: { slot: 1, quantity: 1 },
  cooldown,
  apply(game, at, aim) {
    const x = at.x + Math.cos(aim) * 20;
    const y = at.y + Math.sin(aim) * 20;
    for (const entity of game.entities.values()) {
      if (Math.hypot(entity.x - x, entity.y - y) <= 30) applyDamage(entity, 4);
    }
  },
  show(game, at) {
    void game.sfx.play("poke", at, game.local);
    return { center: { x: at.x, y: at.y }, hit: false };
  },
  draw: () => undefined,
})).create({ poke: 0.5 });

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

/** A sound played: where from, and who heard it. */
interface Sound {
  readonly url: string;
  readonly origin: Point | null;
  readonly listener: Point | null;
}

function setup(
  hub = createHub(),
  id = "me",
  clock = createManualClock(),
  content: readonly WorldContent[] = [blobs, biters, poke],
) {
  const log: string[] = [];
  const failures: { peerFailed: (id: string) => void }[] = [];
  const transport = hub.transport(id, log);
  let changes = 0;
  const sounds: Sound[] = [];
  const room = createRoom({
    localId: id,
    world: "dev",
    transport: transport.port,
    voice: recordingVoice(log, failures),
    sfx: {
      ...testSfx(),
      play(url, origin, listener) {
        sounds.push({
          url,
          origin: origin === null ? null : { x: origin.x, y: origin.y },
          listener,
        });
        return Promise.resolve({
          stop: () => undefined,
          setVolume: () => undefined,
          setPosition: () => undefined,
        });
      },
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
    content,
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
    /** Every sound played, oldest first. */
    sounds,
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
    other.send(NetEvent.STATE, {
      id: "x",
      name: "X",
      ...spot,
      aim: 0,
      health: 100,
      content: {},
    });
  };
  const beat = (hidden: boolean) => {
    other.send(NetEvent.HEARTBEAT, { id: "x", hidden, host: null });
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
    other.send(NetEvent.STATE, {
      id: "x",
      name: "X",
      x: 0,
      y: 0,
      aim: 0,
      health: 100,
      content: {},
    });
    expect(hasX()).toBe(false);
    expect(log).not.toContain("peers x");
  });

  test("a held item change on one client shows on the other", async () => {
    const { a, b, clock } = await pair();
    const session = joined(b.room).session;
    const select = (slot: number) => {
      updateSession(session, { ...idle, select: slot }, 1 / 60);
      clock.advance(clock.now() + SEND_GAP);
      b.room.frame(clock.now());
    };
    const seen = () => {
      const game = joined(a.room).session;
      const remote = game.players.get("b");
      return remote === undefined ? undefined : heldItemOf(game, remote);
    };

    expect(seen()).toBeNull();
    select(1);
    expect(seen()).toEqual({
      id: "poke",
      name: "Poke",
      maxStack: 1,
      emoji: "👉",
    });
    expect(joined(a.room).session.players.get("b")?.inventory).toEqual(
      Array(testSimConfig.player.inventorySlots).fill(null),
    );
    select(0);
    expect(seen()).toBeNull();
  });

  test("a STATE holding an item this client does not know adds the player holding nothing", async () => {
    const { other, session, spot } = await withListener();
    other.send(NetEvent.STATE, {
      id: "x",
      name: "X",
      ...spot,
      aim: 0,
      health: 100,
      content: { "core/held": "laser" },
    });
    const remote = session.players.get("x");
    expect(remote === undefined ? undefined : heldItemId.get(remote)).toBe(
      "laser",
    );
    expect(
      remote === undefined ? undefined : heldItemOf(session, remote),
    ).toBeNull();
  });

  test("a STATE records when the player was heard", async () => {
    const { room, clock, sendState } = await withListener();
    clock.advance(500);
    sendState();
    expect(room.presenceOf("x")).toEqual({ kind: "present", lastHeard: 500 });
  });
});

describe("content's player state", () => {
  /** A lamp every player carries, lit or not, its fuel possibly endless. */
  const lampState = playerData({
    schema: z.object({ lit: z.boolean(), fuel: Health }),
    initial: () => ({ lit: false, fuel: 10 }),
  });
  const lamp: WorldContent = {
    name: "item/lamp",
    player: lampState,
    register: () => undefined,
    populate: () => undefined,
  };
  const content = [poke, lamp];

  test("a value set on one client shows on the other", async () => {
    const clock = createManualClock();
    const a = setup(createHub(), "a", clock, content);
    const b = setup(a.hub, "b", clock, content);
    await a.room.join("ABC", "A");
    await b.room.join("ABC", "B");
    const seen = () => {
      const remote = joined(a.room).session.players.get("b");
      return remote === undefined ? undefined : lampState.get(remote);
    };
    expect(seen()).toEqual({ lit: false, fuel: 10 });

    lampState.set(joined(b.room).session.local, { lit: true, fuel: Infinity });
    clock.advance(clock.now() + SEND_GAP);
    b.room.frame(clock.now());
    expect(seen()).toEqual({ lit: true, fuel: Infinity });
  });

  test("the held item reaches the others with no content listed", async () => {
    const clock = createManualClock();
    const a = setup(createHub(), "a", clock, []);
    const b = setup(a.hub, "b", clock, []);
    await a.room.join("ABC", "A");
    await b.room.join("ABC", "B");
    heldItemId.set(joined(b.room).session.local, "poke");
    clock.advance(clock.now() + SEND_GAP);
    b.room.frame(clock.now());
    const remote = joined(a.room).session.players.get("b");
    expect(remote === undefined ? undefined : heldItemId.get(remote)).toBe(
      "poke",
    );
  });

  test("an entity and an item of the same name sync their own state, each under its namespace", async () => {
    const glow = playerData({ schema: z.number(), initial: () => 1 });
    const fuel = playerData({ schema: z.number(), initial: () => 2 });
    const lamps = [
      defineEntity("lamp", () => ({
        radius: 10,
        maxHealth: 10,
        data: z.object({}),
        player: glow,
        draw: () => undefined,
      })).create({ lamp: undefined }),
      defineItem("lamp", () => ({
        name: "Lamp",
        maxStack: 1,
        emoji: "🪔",
        player: fuel,
        cooldown: 1,
        apply: () => undefined,
        show: (_game, at) => ({ center: at, hit: false }),
        draw: () => undefined,
      })).create({ lamp: undefined }),
    ];
    const clock = createManualClock();
    const a = setup(createHub(), "a", clock, lamps);
    const b = setup(a.hub, "b", clock, lamps);
    await a.room.join("ABC", "A");
    await b.room.join("ABC", "B");
    const listener = a.hub.listener("dev:ABC");
    const local = joined(b.room).session.local;
    glow.set(local, 5);
    fuel.set(local, 7);
    clock.advance(clock.now() + SEND_GAP);
    b.room.frame(clock.now());

    const remote = joined(a.room).session.players.get("b");
    expect(
      remote === undefined ? undefined : [glow.get(remote), fuel.get(remote)],
    ).toEqual([5, 7]);
    const sent = listener.heard.filter(({ event }) => event === NetEvent.STATE);
    expect(sent.at(-1)?.payload).toMatchObject({
      content: { "core/held": null, "entity/lamp": 5, "item/lamp": 7 },
    });
  });

  /** A room joined as "me" with the lamp, and a report from a bare listener "x" of its content. */
  async function reported() {
    const ctx = setup(createHub(), "me", createManualClock(), content);
    await ctx.room.join("ABC", "ME");
    const other = ctx.hub.listener("dev:ABC");
    const session = joined(ctx.room).session;
    const spot = randomFreePosition(session.world, session.local.radius);
    const report = (entries: Record<string, unknown>, name = "X") => {
      other.send(NetEvent.STATE, {
        id: "x",
        name,
        ...spot,
        aim: 0,
        health: 100,
        content: entries,
      });
      const remote = session.players.get("x");
      return remote === undefined
        ? undefined
        : { lamp: lampState.get(remote), held: heldItemId.get(remote) };
    };
    return { session, report };
  }

  test("a new remote player that reports nothing for an entry has its initial value", async () => {
    const { report } = await reported();
    expect(report({})).toEqual({ lamp: { lit: false, fuel: 10 }, held: null });
  });

  test("an unknown entry or a value its entry rejects is dropped, and the rest of the STATE applies", async () => {
    const { session, report } = await reported();
    expect(
      report(
        { "item/lamp": { lit: "yes", fuel: 1 }, "core/held": "poke", ghost: 1 },
        "XY",
      ),
    ).toEqual({ lamp: { lit: false, fuel: 10 }, held: "poke" });
    expect(session.players.get("x")?.name).toBe("XY");
    expect(
      report({ "item/lamp": { lit: true, fuel: "Infinity" }, "core/held": 7 }),
    ).toEqual({
      lamp: { lit: true, fuel: Infinity },
      held: "poke",
    });
  });

  test("an entry missing from a STATE keeps its last value", async () => {
    const { report } = await reported();
    report({ "item/lamp": { lit: true, fuel: 3 }, "core/held": "poke" });
    expect(report({})).toEqual({ lamp: { lit: true, fuel: 3 }, held: "poke" });
  });
});

describe("presence", () => {
  /** The view a player alone in the room elects on its first heartbeat. */
  const alone = { id: "me", term: 0, solo: true };

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
      { id: "me", hidden: false, host: alone },
      { id: "me", hidden: false, host: alone },
      { id: "me", hidden: false, host: alone },
    ]);
  });

  test("the pulse keeps beating while hidden, with the hidden flag", async () => {
    const { room, other, clock } = await withListener();
    room.setHidden(true);
    clock.advance(2000);
    expect(other.heard.map((message) => message.payload)).toEqual([
      { id: "me", hidden: true, host: null },
      { id: "me", hidden: true, host: alone },
      { id: "me", hidden: true, host: alone },
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
    const last = other.heard
      .filter((message) => message.event === NetEvent.STATE)
      .at(-1);
    expect(last?.payload).toEqual(playerState(joined(room).session));
  });

  test("hiding sends a hidden heartbeat at once", async () => {
    const { room, other } = await watched();
    room.setHidden(true);
    expect(other.heard).toEqual([
      {
        event: NetEvent.HEARTBEAT,
        payload: { id: "me", hidden: true, host: null },
      },
    ]);
  });

  test("becoming visible sends a heartbeat at once and a forced STATE on the next frame, and no HELLO", async () => {
    const { room, other, states } = await watched();
    room.frame(SEND_GAP + 1);
    room.setHidden(true);
    other.heard.length = 0;
    room.setHidden(false);
    expect(other.heard).toEqual([
      {
        event: NetEvent.HEARTBEAT,
        payload: { id: "me", hidden: false, host: null },
      },
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
    other.send(NetEvent.STATE, {
      id: "x",
      name: 5,
      ...spot,
      aim: 0,
      health: 100,
      content: {},
    });
    expect(session.players.has("x")).toBe(false);
    expect(room.presenceOf("x")).toBeUndefined();
  });

  test("a BYE without an id drops no one", async () => {
    const { other, session, spot } = await heard();
    other.send(NetEvent.STATE, {
      id: "x",
      name: "X",
      ...spot,
      aim: 0,
      health: 100,
      content: {},
    });
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

  test("a HELLO without an id forces no reply", async () => {
    const { other } = await heard();
    other.send(NetEvent.HELLO, null);
    expect(other.heard).toEqual([]);
    other.send(NetEvent.HELLO, { id: "x" });
    expect(other.heard.map((message) => message.event)).toEqual([
      NetEvent.STATE,
      NetEvent.HEARTBEAT,
    ]);
  });
});

describe("host", () => {
  type Player = ReturnType<typeof setup>;

  /**
   * Players joined in order to one room. They share one clock, except those in `own`, whose
   * clocks move only when told to.
   */
  async function gather(
    ids: readonly string[],
    own: readonly string[] = [],
    content?: readonly WorldContent[],
  ) {
    const hub = createHub();
    const clock = createManualClock();
    const players = new Map<string, Player>();
    const get = (id: string): Player => {
      const player = players.get(id);
      if (player === undefined) throw new Error(`no player ${id}`);
      return player;
    };
    const add = async (id: string): Promise<Player> => {
      const player = setup(
        hub,
        id,
        own.includes(id) ? createManualClock() : clock,
        content,
      );
      players.set(id, player);
      await player.room.join("ABC", id.toUpperCase());
      return player;
    };
    for (const id of ids) await add(id);
    const hosts = () => [...players.values()].map(({ room }) => room.hostId());
    return { hub, clock, get, add, hosts };
  }

  /** `values` with each run of repeats cut to one. */
  const runs = <T>(values: readonly T[]): T[] =>
    values.filter((value, index) => index === 0 || value !== values[index - 1]);

  test("is undefined outside a room, and the local player alone after a heartbeat", async () => {
    const { room, clock } = setup();
    expect(room.hostId()).toBeUndefined();
    await room.join("ABC", "ME");
    expect(room.hostId()).toBeUndefined();
    clock.advance(1000);
    expect(room.hostId()).toBe("me");
    await room.leave();
    expect(room.hostId()).toBeUndefined();
  });

  test("the first players agree on the lowest id", async () => {
    const { clock, hosts } = await gather(["b", "c", "a"]);
    clock.advance(1000);
    expect(hosts()).toEqual(["a", "a", "a"]);
  });

  test("a newcomer adopts the host at once, even with a lower id", async () => {
    const { clock, add, hosts } = await gather(["b", "c"]);
    clock.advance(1000);
    const a = await add("a");
    expect(a.room.hostId()).toBe("b");
    clock.advance(10_000);
    expect(hosts()).toEqual(["b", "b", "b"]);
  });

  test("a hitch on the host hands over once, with no hand-back", async () => {
    const { clock, get, hosts } = await gather(["a", "b", "c"], ["a"]);
    clock.advance(1000);
    get("a").clock.advance(1000);
    expect(hosts()).toEqual(["a", "a", "a"]);

    const seen: (string | undefined)[][] = [[], [], []];
    for (let time = 1500; time <= 15_000; time += 500) {
      clock.advance(time);
      if (time >= 7000) get("a").clock.stall(time);
      hosts().forEach((host, index) => seen[index]?.push(host));
    }
    expect(seen.map(runs)).toEqual([
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  test("a host cut off from the room keeps the role alone, then steps down when it returns", async () => {
    const { hub, clock, hosts } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    hub.partition(["a"], ["b", "c"]);
    clock.advance(6000);
    expect(hosts()).toEqual(["a", "b", "b"]);
    hub.heal();
    clock.advance(8000);
    expect(hosts()).toEqual(["b", "b", "b"]);
  });

  test("players that elected apart agree within a heartbeat of hearing each other", async () => {
    const { hub, clock, hosts } = await gather(["a", "b", "c", "d", "e"]);
    clock.advance(1000);
    hub.partition(["a"], ["b", "c"], ["d", "e"]);
    clock.advance(6000);
    expect(hosts()).toEqual(["a", "b", "b", "d", "d"]);
    hub.heal();
    clock.advance(7000);
    expect(hosts()).toEqual(["b", "b", "b", "b", "b"]);
    clock.advance(20_000);
    expect(hosts()).toEqual(["b", "b", "b", "b", "b"]);
  });

  /** The host view in the last heartbeat `id` sent, as heard by a bare listener. */
  function lastView(
    listener: ReturnType<ReturnType<typeof createHub>["listener"]>,
    id: string,
  ) {
    const beats = listener.heard.flatMap(({ event, payload }) => {
      const parsed = heartbeat.safeParse(payload);
      return event === NetEvent.HEARTBEAT && parsed.data?.id === id
        ? [parsed.data.host]
        : [];
    });
    return beats.at(-1);
  }

  test("a player cut off from the room elects itself solo, then steps down when it returns", async () => {
    const { hub, clock, get, hosts } = await gather(["c", "a", "b"]);
    clock.advance(1000);
    expect(hosts()).toEqual(["a", "a", "a"]);
    hub.partition(["c"], ["a", "b"]);
    clock.advance(6000);
    expect(hosts()).toEqual(["c", "a", "a"]);

    hub.heal();
    // States reach c before any heartbeat, so it sees the others active while still solo.
    get("a").room.frame(clock.now());
    get("b").room.frame(clock.now());
    expect(get("c").room.presenceOf("a")?.kind).toBe("present");
    clock.advance(8000);
    expect(hosts()).toEqual(["a", "a", "a"]);
    clock.advance(20_000);
    expect(hosts()).toEqual(["a", "a", "a"]);
  });

  test("the last player left hosts solo, and keeps the role when a newcomer joins", async () => {
    const { hub, clock, get, add, hosts } = await gather(["a", "b", "c"]);
    const listener = hub.listener("dev:ABC");
    clock.advance(1000);
    await get("a").room.leave();
    await get("b").room.leave();
    clock.advance(2000);
    expect(get("c").room.hostId()).toBe("c");
    expect(lastView(listener, "c")).toEqual({ id: "c", term: 1, solo: true });

    const newcomer = await add("b2");
    expect(newcomer.room.hostId()).toBe("c");
    clock.advance(4000);
    expect(lastView(listener, "c")).toEqual({ id: "c", term: 1, solo: false });
    expect(lastView(listener, "b2")).toEqual({ id: "c", term: 1, solo: false });
    clock.advance(20_000);
    expect(hosts().slice(2)).toEqual(["c", "c"]);
  });

  test("two solo islands agree by term, then id, once they hear each other", async () => {
    const { hub, clock, get, hosts } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    hub.partition(["a"], ["b"], ["c"]);
    clock.advance(6000);
    expect(hosts()).toEqual(["a", "b", "c"]);
    await get("a").room.leave();
    hub.heal();
    clock.advance(8000);
    expect(hosts().slice(1)).toEqual(["b", "b"]);
  });

  test("hands over at the next heartbeat when the host leaves", async () => {
    const { clock, get } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    await get("a").room.leave();
    clock.advance(2000);
    expect([get("b").room.hostId(), get("c").room.hostId()]).toEqual([
      "b",
      "b",
    ]);
  });

  test("hands over when the host times out", async () => {
    const { clock, get } = await gather(["a", "b", "c"], ["a"]);
    clock.advance(1000);
    get("a").clock.advance(1000);
    clock.advance(32_000);
    expect(get("b").room.presenceOf("a")).toBeUndefined();
    expect([get("b").room.hostId(), get("c").room.hostId()]).toEqual([
      "b",
      "b",
    ]);
  });

  test("a hidden host hands over, and does not take the role back when shown", async () => {
    const { clock, get, hosts } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    get("a").room.setHidden(true);
    clock.advance(2000);
    expect(hosts()).toEqual(["b", "b", "b"]);
    get("a").room.setHidden(false);
    clock.advance(10_000);
    expect(hosts()).toEqual(["b", "b", "b"]);
  });

  test("with every page hidden, the host stays", async () => {
    const { clock, get, hosts } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    for (const id of ["a", "b", "c"]) get(id).room.setHidden(true);
    clock.advance(5000);
    expect(hosts()).toEqual(["a", "a", "a"]);
  });

  test("a newcomer passes over a hidden page", async () => {
    const { clock, get, add, hosts } = await gather(["a", "b", "c"]);
    clock.advance(1000);
    get("a").room.setHidden(true);
    clock.advance(2000);
    const d = await add("d");
    expect(d.room.presenceOf("a")?.kind).toBe("away");
    expect(d.room.hostId()).toBe("b");
    clock.advance(5000);
    expect(hosts()).toEqual(["b", "b", "b", "b"]);
  });

  describe("entities", () => {
    const sessionOf = (player: Player) => joined(player.room).session;
    const ids = (player: Player) => [...sessionOf(player).entities.keys()];
    const placed = (player: Player) =>
      [...sessionOf(player).entities.values()].map(({ id, x, y }) => ({
        id,
        x,
        y,
      }));
    /** Where `player` is easing each entity to. */
    const targets = (player: Player) =>
      [...sessionOf(player).entities.values()].map(({ id, tx, ty }) => ({
        id,
        x: tx,
        y: ty,
      }));
    /** Runs one step of simulation on `player`, without letting it send. */
    const step = (player: Player) => {
      updateSession(sessionOf(player), idle, 1 / 60);
    };
    /** Runs `seconds` of simulation on `player`, then lets it send. */
    const play = (player: Player, seconds: number) => {
      for (let step = 0; step < seconds * 60; step++)
        updateSession(sessionOf(player), idle, 1 / 60);
      player.room.frame(player.clock.now());
    };

    test("every client numbers the kinds by the order of its content list", async () => {
      const kinds = (player: Player) => [...sessionOf(player).kindIds];
      const { get } = await gather(["a", "b"]);
      expect(kinds(get("a"))).toEqual([
        ["blob", 1],
        ["biter", 2],
      ]);
      expect(kinds(get("b"))).toEqual(kinds(get("a")));

      const reversed = await gather(["c"], [], [biters, blobs]);
      expect(kinds(reversed.get("c"))).toEqual([
        ["biter", 1],
        ["blob", 2],
      ]);
    });

    test("an unbreakable entity reaches the other players whole", async () => {
      const rocks: WorldContent = {
        name: "entity/rock",
        register(session) {
          registerEntityType(session, "rock", {
            radius: 10,
            maxHealth: Infinity,
            data: z.object({}),
            draw: () => undefined,
          });
        },
        populate(session) {
          spawnEntity(session, "rock", 450, 300, {});
        },
      };
      const { clock, get } = await gather(["a", "b"], [], [blobs, rocks]);
      clock.advance(1000);
      play(get("a"), 0);
      expect(
        [...sessionOf(get("b")).entities.values()].map(({ id, health }) => ({
          id,
          health,
        })),
      ).toEqual([
        { id: "a:1", health: 10 },
        { id: "a:2", health: 10 },
        { id: "a:3", health: 10 },
        { id: "a:4", health: Infinity },
      ]);
    });

    test("each world is populated once, by its first host, and not again on a handover", async () => {
      const populated: string[] = [];
      const counted: WorldContent = {
        name: "entity/counted",
        register: () => undefined,
        populate(session) {
          populated.push(session.localId);
        },
      };
      const { clock, get } = await gather(
        ["a", "b", "c"],
        [],
        [blobs, counted],
      );
      expect(populated).toEqual([]);
      clock.advance(1000);
      play(get("a"), 0);
      expect(populated).toEqual(["a"]);

      await get("a").room.leave();
      clock.advance(3000);
      expect(get("b").room.hostId()).toBe("b");
      play(get("b"), 1);
      await get("b").room.leave();
      clock.advance(5000);
      expect(get("c").room.hostId()).toBe("c");
      expect(ids(get("c"))).toEqual(["a:1", "a:2", "a:3"]);
      expect(populated).toEqual(["a"]);
    });

    test("the first host spawns them once, and a newcomer takes them from it", async () => {
      const { clock, get, add } = await gather(["a"]);
      expect(ids(get("a"))).toEqual([]);
      clock.advance(1000);
      expect(ids(get("a"))).toEqual(["a:1", "a:2", "a:3"]);

      const b = await add("b");
      expect(placed(b)).toEqual(placed(get("a")));
      clock.advance(10_000);
      expect(ids(get("a"))).toEqual(["a:1", "a:2", "a:3"]);
      expect(ids(b)).toEqual(["a:1", "a:2", "a:3"]);
    });

    test("players that join together see only the host's", async () => {
      const { clock, get } = await gather(["b", "a"]);
      clock.advance(1000);
      expect(ids(get("b"))).toEqual([]);
      play(get("a"), 0.5);
      expect(ids(get("b"))).toEqual(["a:1", "a:2", "a:3"]);
    });

    test("only the host runs them; the others follow its snapshots", async () => {
      const { clock, get } = await gather(["a", "b"]);
      clock.advance(1000);
      play(get("a"), 0);
      const before = placed(get("b"));
      play(get("b"), 2);
      expect(placed(get("b"))).toEqual(before);

      clock.advance(2000);
      play(get("a"), 2);
      play(get("b"), 1);
      expect(placed(get("b"))).not.toEqual(before);
      for (const [index, entity] of placed(get("b")).entries()) {
        const host = placed(get("a"))[index];
        expect(entity.id).toBe(host?.id);
        expect(entity.x).toBeCloseTo(host?.x ?? NaN, 1);
        expect(entity.y).toBeCloseTo(host?.y ?? NaN, 1);
      }
    });

    test("snapshots from a player not taken for host are ignored", async () => {
      const { hub, clock, get } = await gather(["a", "b"]);
      const listener = hub.listener("dev:ABC");
      clock.advance(1000);
      play(get("a"), 0);
      const entity = { id: "z:1", kind: 1, x: 450, y: 300, health: 10 };
      const data = { steps: 0 };
      listener.send(NetEvent.ENTITIES, {
        host: "b",
        entities: [{ ...entity, data }],
      });
      listener.send(NetEvent.ENTITIES, {
        host: "z",
        entities: [{ ...entity, data }],
      });
      expect(ids(get("a"))).toEqual(["a:1", "a:2", "a:3"]);
      expect(ids(get("b"))).toEqual(["a:1", "a:2", "a:3"]);

      listener.send(NetEvent.ENTITIES, {
        host: "a",
        entities: [{ ...entity, data }],
      });
      expect(ids(get("b"))).toEqual(["z:1"]);
    });

    test("a new host runs on from its last snapshot, every id kept", async () => {
      const { clock, get } = await gather(["a", "b", "c"]);
      clock.advance(1000);
      play(get("a"), 1);
      const handed = placed(get("b"));
      await get("a").room.leave();
      clock.advance(2000);
      expect(get("b").room.hostId()).toBe("b");
      expect(ids(get("b"))).toEqual(["a:1", "a:2", "a:3"]);

      play(get("b"), 2);
      expect(placed(get("b"))).not.toEqual(handed);
      expect(ids(get("c"))).toEqual(["a:1", "a:2", "a:3"]);
      expect(targets(get("c"))).toEqual(placed(get("b")));
    });

    test("a player cut off before it heard them spawns its own, and drops them on rejoining", async () => {
      const { hub, clock, get, add } = await gather(["a", "b"]);
      clock.advance(1000);
      hub.partition(["a", "b"], ["c"]);
      const c = await add("c");
      clock.advance(2000);
      expect(c.room.hostId()).toBe("c");
      expect(ids(c)).toEqual(["c:1", "c:2", "c:3"]);

      hub.heal();
      clock.advance(4000);
      play(get("a"), 0);
      expect(c.room.hostId()).toBe("a");
      expect(ids(c)).toEqual(["a:1", "a:2", "a:3"]);
      expect(ids(get("a"))).toEqual(["a:1", "a:2", "a:3"]);
      expect(ids(get("b"))).toEqual(["a:1", "a:2", "a:3"]);
    });

    test("after a split, the side that keeps the host keeps its monsters", async () => {
      const { hub, clock, get } = await gather(["a", "b"]);
      clock.advance(1000);
      play(get("a"), 0);
      hub.partition(["a"], ["b"]);
      clock.advance(6000);
      expect(get("b").room.hostId()).toBe("b");
      expect(ids(get("b"))).toEqual(["a:1", "a:2", "a:3"]);
      play(get("b"), 1);

      hub.heal();
      clock.advance(8000);
      play(get("a"), 1);
      expect(get("b").room.hostId()).toBe("a");
      expect(targets(get("b"))).toEqual(placed(get("a")));
    });

    test("every client hears each entity's cues at most once a frame, from where it stands", async () => {
      const { clock, get } = await gather(["a", "b"]);
      const steps = (player: Player) =>
        player.sounds.filter(({ url }) => url === "step");
      clock.advance(1000);
      play(get("a"), 0);
      get("b").room.frame(clock.now());
      expect(steps(get("a"))).toEqual([]);
      expect(steps(get("b"))).toEqual([]);

      clock.advance(2000);
      play(get("a"), 1);
      expect(steps(get("a"))).toHaveLength(3);
      get("b").room.frame(clock.now());
      expect(steps(get("b")).map(({ listener }) => listener)).toEqual(
        Array(3).fill(sessionOf(get("b")).local),
      );
      get("b").room.frame(clock.now());
      expect(steps(get("b"))).toHaveLength(3);
    });

    describe("health", () => {
      /** Two players, `a` hosting with its blobs sent to `b`. */
      async function hosted() {
        const { hub, clock, get } = await gather(["a", "b"]);
        clock.advance(1000);
        play(get("a"), 0);
        return { hub, clock, a: get("a"), b: get("b") };
      }

      /** Moves `player` to `at`, facing right, and sends its state there. */
      const standAt = (player: Player, at: Point) => {
        Object.assign(sessionOf(player).local, { ...at, aim: 0 });
        player.clock.advance(player.clock.now() + 200);
        player.room.frame(player.clock.now());
      };

      /** Hands `use` to the room as the local player's use, skipping its own cooldown. */
      const sendUse = (player: Player, use: Point & { aim: number }) => {
        sessionOf(player).outbox.push({
          content: "core/held",
          event: "use",
          route: "all",
          to: null,
          payload: { item: "poke", ...use },
        });
        player.room.frame(player.clock.now());
      };

      /** `player` pokes from 20px left of `target`, after standing there. */
      const pokeAt = (player: Player, target: Point) => {
        const at = { x: target.x - 20, y: target.y };
        standAt(player, at);
        sendUse(player, { ...at, aim: 0 });
      };

      const healthOf = (player: Player, id: string) =>
        sessionOf(player).entities.get(id)?.health;

      test("a non-host's hit lands on the host, every client sees the health, and a kill removes it everywhere", async () => {
        const { clock, a, b } = await hosted();
        const blob = () =>
          sessionOf(a).entities.get("a:2") ?? { x: NaN, y: NaN };

        pokeAt(b, blob());
        expect(healthOf(b, "a:2")).toBe(10);
        clock.advance(clock.now() + 200);
        play(a, 1 / 60);
        expect(healthOf(a, "a:2")).toBe(6);
        expect(healthOf(b, "a:2")).toBe(6);

        pokeAt(b, blob());
        play(a, 1 / 60);
        expect(healthOf(a, "a:2")).toBe(6);

        play(a, 0.5);
        pokeAt(b, blob());
        play(a, 0.5);
        pokeAt(b, blob());
        clock.advance(clock.now() + 200);
        play(a, 1 / 60);
        expect(ids(a)).toEqual(["a:1", "a:3"]);
        expect(ids(b)).toEqual(["a:1", "a:3"]);
      });

      test("an item defined as content starts in its slot, and is selected, used, applied by the host and shown to the others", async () => {
        const { clock, a, b } = await hosted();
        const blob = sessionOf(a).entities.get("a:2") ?? { x: NaN, y: NaN };
        standAt(b, { x: blob.x - 20, y: blob.y });
        const local = sessionOf(b).local;
        expect(local.inventory.map((stack) => stack?.item.id ?? null)).toEqual([
          null,
          "poke",
          null,
          null,
        ]);
        const use = { ...idle, aim: blob, select: 1, use: true };
        updateSession(sessionOf(b), use, 1 / 60);
        b.room.frame(b.clock.now());
        expect(local.held).toBe(1);
        expect(local.use?.item).toBe("poke");
        expect(sessionOf(a).players.get("b")?.use).toBeNull();
        step(a);
        const seen = sessionOf(a).players.get("b");
        expect(seen?.use).toMatchObject({ item: "poke", hit: false });
        expect(a.sounds.filter(({ url }) => url === "poke")).toHaveLength(1);
        clock.advance(clock.now() + 200);
        b.room.frame(clock.now());
        expect(seen === undefined ? undefined : heldItemId.get(seen)).toBe(
          "poke",
        );
        play(a, 1 / 60);
        expect(healthOf(a, "a:2")).toBe(6);
        expect(healthOf(b, "a:2")).toBe(6);
      });

      test("every client hears a use once, from where it was made", async () => {
        const { a, b } = await hosted();
        standAt(a, { x: 100, y: 500 });
        standAt(b, { x: 400, y: 500 });
        play(a, 1);
        play(b, 1);
        const pokes = (player: Player) =>
          player.sounds.filter(({ url }) => url === "poke");
        const swing = (player: Player) => {
          const { local } = sessionOf(player);
          updateSession(
            sessionOf(player),
            { ...idle, select: 1, use: true },
            1 / 60,
          );
          player.room.frame(player.clock.now());
          return { x: local.x, y: local.y };
        };

        const from = swing(b);
        expect(pokes(a)).toEqual([]);
        step(a);
        expect(pokes(b)).toEqual([
          { url: "poke", origin: from, listener: sessionOf(b).local },
        ]);
        expect(pokes(a)).toEqual([
          { url: "poke", origin: from, listener: sessionOf(a).local },
        ]);

        swing(a);
        step(b);
        expect(pokes(a)).toHaveLength(2);
        expect(pokes(b)).toHaveLength(2);
      });

      test("a remote use is kept on its player to draw, from where it was made", async () => {
        const { a, b } = await hosted();
        standAt(b, { x: 400, y: 500 });
        sendUse(b, { x: 400, y: 500, aim: 0 });
        step(a);
        step(b);
        expect(sessionOf(a).players.get("b")?.use).toEqual({
          item: "poke",
          center: { x: 400, y: 500 },
          hit: false,
          startedAt: sessionOf(a).time,
        });
        expect(sessionOf(b).players.get("a")?.use).toBeNull();
      });

      test("the host applies its own use through the same checks", async () => {
        const { clock, a, b } = await hosted();
        const blob = sessionOf(a).entities.get("a:2") ?? { x: NaN, y: NaN };
        pokeAt(a, blob);
        clock.advance(clock.now() + 200);
        play(a, 1 / 60);
        expect(healthOf(a, "a:2")).toBe(6);
        expect(healthOf(b, "a:2")).toBe(6);
      });

      test("a use far from where the host last saw its player does nothing", async () => {
        const { a, b } = await hosted();
        const blob = sessionOf(a).entities.get("a:2") ?? { x: NaN, y: NaN };
        standAt(b, { x: blob.x - 200, y: blob.y });
        sendUse(b, { x: blob.x - 20, y: blob.y, aim: 0 });
        play(a, 1 / 60);
        expect(healthOf(a, "a:2")).toBe(10);
      });

      test("a monster's strike hurts each player on its own client, and every client sees it", async () => {
        const { a, b } = await hosted();
        standAt(a, { x: 100, y: 500 });
        standAt(b, { x: 500, y: 500 });
        const host = sessionOf(a);
        for (let step = 0; step < 60; step++) updateSession(host, idle, 1 / 60);
        const remote = host.players.get("b") ?? { x: NaN, y: NaN };
        spawnEntity(host, BITER, remote.x, remote.y, {});
        spawnEntity(host, BITER, host.local.x, host.local.y, {});

        updateSession(host, idle, 1 / 60);
        expect(host.local.health).toBe(95);
        expect(host.players.get("b")?.health).toBe(100);
        a.clock.advance(a.clock.now() + 200);
        a.room.frame(a.clock.now());
        expect(sessionOf(b).local.health).toBe(100);
        step(b);
        expect(sessionOf(b).local.health).toBe(95);
        expect(sessionOf(b).players.get("a")?.health).toBe(95);

        b.room.frame(b.clock.now());
        expect(host.players.get("b")?.health).toBe(95);
      });

      test("damage said to come from anyone but the host, or for another player, is ignored", async () => {
        const { hub, a, b } = await hosted();
        const listener = hub.listener("dev:ABC");
        const damage = (from: string, to: string) => {
          listener.send(NetEvent.CONTENT, {
            from,
            to,
            content: "core/health",
            event: "damage",
            payload: { amount: 5 },
          });
          step(a);
          step(b);
        };
        damage("b", "a");
        damage("z", "b");
        damage("a", "a");
        expect(sessionOf(a).local.health).toBe(100);
        expect(sessionOf(b).local.health).toBe(100);
        damage("a", "b");
        expect(sessionOf(a).local.health).toBe(100);
        expect(sessionOf(b).local.health).toBe(95);
      });
    });
  });
  describe("content events", () => {
    const sessionOf = (player: Player) => joined(player.room).session;
    const step = (player: Player) => {
      updateSession(sessionOf(player), idle, 1 / 60);
    };

    /** An entry with an event of each route, and one only the host may send, each logging what it hears. */
    function signals() {
      const log: string[] = [];
      const Signal = z.object({ n: z.number().int() });
      const note =
        (name: string) =>
        (game: Session, { n }: z.infer<typeof Signal>, sender: string) => {
          log.push(`${game.localId} ${name} ${String(n)} from ${sender}`);
        };
      const toHost = contentEvent({
        schema: Signal,
        to: "host",
        receive: note("host"),
      });
      const toAll = contentEvent({
        schema: Signal,
        to: "all",
        receive: note("all"),
      });
      const toPlayer = contentEvent({
        schema: Signal,
        to: "player",
        receive: note("player"),
      });
      const fromHost = contentEvent({
        schema: Signal,
        to: "all",
        from: "host",
        receive: note("from-host"),
      });
      const content: WorldContent = {
        name: "item/signal",
        events: { toHost, toAll, toPlayer, fromHost },
        register: () => undefined,
        populate: () => undefined,
      };
      return { log, content, toHost, toAll, toPlayer, fromHost };
    }

    /** Three players hosted by `a`, each with the signals. */
    async function signalling() {
      const signal = signals();
      const { hub, clock, get } = await gather(
        ["a", "b", "c"],
        [],
        [signal.content],
      );
      clock.advance(1000);
      const [a, b, c] = [get("a"), get("b"), get("c")];
      const stepAll = () => {
        for (const player of [a, b, c]) step(player);
      };
      return { ...signal, hub, a, b, c, stepAll };
    }

    test("each event reaches only the clients its route names, inside their next step", async () => {
      const { log, b, toHost, toAll, toPlayer, stepAll } = await signalling();
      toHost.send(sessionOf(b), { n: 1 });
      toAll.send(sessionOf(b), { n: 2 });
      toPlayer.send(sessionOf(b), "c", { n: 3 });
      b.room.frame(b.clock.now());
      expect(log).toEqual([]);
      stepAll();
      expect(log).toEqual([
        "a host 1 from b",
        "a all 2 from b",
        "b all 2 from b",
        "c all 2 from b",
        "c player 3 from b",
      ]);
    });

    test("the host's own event for the host, and a player's for itself, stay on its client", async () => {
      const { log, a, b, toHost, toPlayer, stepAll } = await signalling();
      const sent = (player: Player) =>
        player.log.filter((line) => line === "send content");
      toHost.send(sessionOf(a), { n: 1 });
      a.room.frame(a.clock.now());
      toPlayer.send(sessionOf(b), "b", { n: 2 });
      b.room.frame(b.clock.now());
      stepAll();
      expect(log).toEqual(["a host 1 from a", "b player 2 from b"]);
      expect(sent(a)).toEqual([]);
      expect(sent(b)).toEqual([]);
    });

    test("an event only the host may send is dropped from anyone else, its sender included", async () => {
      const { log, a, b, fromHost, stepAll } = await signalling();
      fromHost.send(sessionOf(b), { n: 1 });
      b.room.frame(b.clock.now());
      fromHost.send(sessionOf(a), { n: 2 });
      a.room.frame(a.clock.now());
      stepAll();
      expect(log).toEqual([
        "a from-host 2 from a",
        "b from-host 2 from a",
        "c from-host 2 from a",
      ]);
    });

    test("the host's damage reaches its player with no content listed", async () => {
      const { clock, get } = await gather(["a", "b"], [], []);
      clock.advance(1000);
      const [a, b] = [get("a"), get("b")];
      sessionOf(a).outbox.push({
        content: "core/health",
        event: "damage",
        route: "player",
        to: "b",
        payload: { amount: 5 },
      });
      a.room.frame(clock.now());
      step(b);
      expect(sessionOf(b).local.health).toBe(95);
    });

    test("an unknown entry or event, a payload its event rejects, or a sender not in the room is dropped, and the rest apply", async () => {
      const { log, hub, stepAll } = await signalling();
      const listener = hub.listener("dev:ABC");
      const signal = (fields: Record<string, unknown>) => {
        listener.send(NetEvent.CONTENT, {
          from: "b",
          to: null,
          content: "item/signal",
          event: "toAll",
          payload: { n: 1 },
          ...fields,
        });
      };
      signal({ content: "item/ghost" });
      signal({ event: "ghost" });
      signal({ payload: { n: "1" } });
      signal({ payload: { n: 2 } });
      signal({ from: "z", payload: { n: 3 } });
      signal({ from: "", payload: { n: 4 } });
      signal({ payload: { n: 5 } });
      stepAll();
      expect(log).toEqual([
        "a all 2 from b",
        "a all 5 from b",
        "c all 2 from b",
        "c all 5 from b",
      ]);
    });
  });
});
