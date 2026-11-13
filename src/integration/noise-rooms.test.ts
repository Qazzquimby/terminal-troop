import { expect, test } from "vitest";
import { z } from "zod";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { NetEvent, createCountingTransport } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { createRipples } from "../render/index.js";
import type { Ripples } from "../render/index.js";
import {
  effect,
  isAreaFree,
  mulberry32,
  speak,
  updateSession,
} from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  tenth,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testRippleConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;

/** One blind chaser, so only what it hears moves it off its wander. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 1 },
  },
};

/** Where a chaser investigates, as its snapshot carries it. */
const Investigating = z.object({
  noiseTarget: z.object({ x: z.number(), y: z.number() }).nullable(),
});

const still: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

/** Steps `room` for `seconds`, hearing each step into `ripples` when given, as a frame does. */
function steps(
  room: Room,
  controls: Controls,
  seconds: number,
  ripples?: Ripples,
): void {
  const game = sessionOf(room);
  for (let step = 0; step < Math.round(seconds / DT); step++) {
    updateSession(game, controls, DT);
    ripples?.hear(game, game.time * 1000);
  }
}

function chaserOf(room: Room): WorldEntity {
  const [chaser] = sessionOf(room).entities.values();
  if (chaser === undefined) throw new Error("no chaser");
  return chaser;
}

const noiseTarget = (room: Room): Point | null =>
  Investigating.parse(chaserOf(room).data).noiseTarget;

/** A spot `distance` from `from` where a player fits. */
function freeSpotNear(game: Session, from: Point, distance: number): Point {
  for (let turn = 0; turn < 16; turn++) {
    const angle = (turn / 16) * Math.PI * 2;
    const x = from.x + Math.cos(angle) * distance;
    const y = from.y + Math.sin(angle) * distance;
    if (isAreaFree(game.world.map, x, y, testSimConfig.player.radius + 10))
      return { x, y };
  }
  throw new Error("no free spot");
}

/** Two clients joined to one room on the same hub, `a` hosting. */
async function pair() {
  const hub = createHub();
  const clock = createManualClock();
  /** What each client sent, message by message, batches unpacked. */
  const sent = new Map<string, NetEvent[]>();
  /** Each client's broadcasts over the last second. */
  const broadcasts = new Map<string, () => number>();
  const tapped = (id: string): Transport => {
    const port = hub.transport(id, []).port;
    const log: NetEvent[] = [];
    sent.set(id, log);
    const counted = createCountingTransport(
      {
        ...port,
        send(event, payload) {
          for (const message of messages(event, payload))
            log.push(message.event);
          return port.send(event, payload);
        },
      },
      () => clock.now(),
    );
    broadcasts.set(id, () => counted.rates(clock.now()).sentPerS);
    return counted.transport;
  };
  const client = (id: string): Room =>
    createRoom({
      localId: id,
      world: "dev",
      transport: tapped(id),
      voice: createNullVoice({
        mode: "open",
        muted: false,
        volume: 1,
        inputDevice: null,
      }),
      sfx: testSfx(),
      scope: createScope(),
      clock,
      config: testRoomConfig,
      sim: testSimConfig,
      content: entityContent(entities),
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
  const a = client("a");
  const b = client("b");
  await a.join("NOISE", "A");
  await b.join("NOISE", "B");
  clock.advance(1000);
  expect(a.hostId()).toBe("a");
  const sentBy = (id: string): NetEvent[] => sent.get(id) ?? [];
  const broadcastsBy = (id: string): number => broadcasts.get(id)?.() ?? 0;
  return { a, b, clock, sentBy, broadcastsBy };
}

test("a chaser drawn by a remote player's sprinting keeps investigating when the host changes", async () => {
  const { a, b, clock } = await pair();

  const spot = freeSpotNear(sessionOf(b), chaserOf(a), 250);
  Object.assign(sessionOf(b).local, { ...spot, prevX: spot.x, prevY: spot.y });
  steps(b, { ...still, move: { x: 1, y: 0 }, sprint: true }, DT);
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  b.frame(clock.now());
  steps(a, still, 1);
  a.frame(clock.now());

  const heard = noiseTarget(a);
  if (heard === null) throw new Error("the chaser heard nothing");
  expect(Math.hypot(heard.x - spot.x, heard.y - spot.y)).toBeLessThan(
    250 * testSimConfig.noise.blur + 10,
  );
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });

  await a.leave();
  clock.advance(3000);
  expect(b.hostId()).toBe("b");
  const before = Math.hypot(chaserOf(b).x - heard.x, chaserOf(b).y - heard.y);
  steps(b, still, 1);
  expect(noiseTarget(b)).toEqual({ x: tenth(heard.x), y: tenth(heard.y) });
  expect(
    Math.hypot(chaserOf(b).x - heard.x, chaserOf(b).y - heard.y),
  ).toBeLessThan(before);
});

test("each client sees the other's footsteps, worked out from its state, and the host's noise", async () => {
  const { a, b, clock } = await pair();
  const host = sessionOf(a);
  const guest = sessionOf(b);
  const heardByHost = createRipples(testRippleConfig, mulberry32(1));
  const heardByGuest = createRipples(testRippleConfig, mulberry32(2));
  const spot = freeSpotNear(guest, host.local, 100);
  Object.assign(guest.local, { ...spot, prevX: spot.x, prevY: spot.y });
  steps(b, { ...still, move: { x: 1, y: 0 } }, DT, heardByGuest);
  clock.advance(clock.now() + 1000 / testRoomConfig.sendHz);
  b.frame(clock.now());
  steps(a, still, 1, heardByHost);
  expect(heardByHost.list).toHaveLength(1);
  expect(host.outbox).toEqual([]);

  effect(host, { at: host.local, noise: 300 }, { id: "e1" });
  a.frame(clock.now());
  steps(b, still, DT, heardByGuest);
  expect(guest.noises).toEqual([
    { at: { x: host.local.x, y: host.local.y }, radius: 300, source: "e1" },
  ]);
  expect(heardByGuest.list.at(-1)).toMatchObject({ radius: 300 });
  steps(a, still, DT);
  expect(host.noises).toHaveLength(1);
});

test("a shouting guest draws a chaser from beyond walking range, its voice rippling on the host with no message but its state", async () => {
  const { a, b, clock, sentBy, broadcastsBy } = await pair();
  const host = sessionOf(a);
  const guest = sessionOf(b);
  const { voiceNoise } = testSimConfig;
  const distance = 300;
  expect(distance).toBeGreaterThan(testSimConfig.footsteps.walk.radius);
  expect(distance).toBeLessThan(voiceNoise.radius.loud);
  const spot = freeSpotNear(guest, chaserOf(a), distance);
  Object.assign(guest.local, { ...spot, prevX: spot.x, prevY: spot.y });
  const near = freeSpotNear(host, spot, 100);
  Object.assign(host.local, { ...near, prevX: near.x, prevY: near.y });
  const heardByHost = createRipples(testRippleConfig, mulberry32(1));
  /** The noises the guest's voice made on the host. */
  let voices = 0;

  /** Runs both clients' frames, at 60 a second, for `seconds`, the guest's mic going out at `level`. */
  const run = (seconds: number, level: number): void => {
    for (let step = 0; step < Math.round(seconds / DT); step++) {
      clock.advance(clock.now() + 1000 * DT);
      speak(guest, level);
      updateSession(guest, still, DT);
      b.frame(clock.now());
      updateSession(host, still, DT);
      heardByHost.hear(host, host.time * 1000);
      voices += host.noises.filter(({ source }) => source === "b").length;
      a.frame(clock.now());
    }
  };

  steps(b, { ...still, move: { x: 1, y: 0 } }, DT);
  Object.assign(guest.local, { ...spot, prevX: spot.x, prevY: spot.y });
  run(1, 0);
  expect(noiseTarget(a)).toBeNull();
  const quiet = broadcastsBy("b");
  voices = 0;
  const before = { guest: sentBy("b").length, host: sentBy("a").length };

  run(1, 1);
  const heard = noiseTarget(a);
  if (heard === null) throw new Error("the chaser heard nothing");
  expect(Math.hypot(heard.x - spot.x, heard.y - spot.y)).toBeLessThan(
    distance * testSimConfig.noise.blur + 10,
  );
  expect(voices).toBeGreaterThanOrEqual(Math.floor(1 / voiceNoise.interval));
  expect(voices).toBeLessThanOrEqual(Math.ceil(1 / voiceNoise.interval));
  expect(heardByHost.list.at(-1)).toMatchObject({
    radius: voiceNoise.radius.loud,
  });

  const byGuest = sentBy("b").slice(before.guest);
  expect(byGuest.filter((event) => event === NetEvent.STATE)).toHaveLength(1);
  expect(
    byGuest.every(
      (event) => event === NetEvent.STATE || event === NetEvent.HEARTBEAT,
    ),
  ).toBe(true);
  expect(sentBy("a").slice(before.host)).not.toContain(NetEvent.CONTENT);
  expect(broadcastsBy("b")).toBeLessThanOrEqual(quiet + 1);
});
