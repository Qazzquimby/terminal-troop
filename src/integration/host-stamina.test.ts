import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { isAreaFree, movement, updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  createHub,
  createManualClock,
  messages,
  testRoomConfig,
} from "./room-helpers.js";
import {
  testEntitiesConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;
const { stamina } = testSimConfig;
const { slack } = testSimConfig.net.stamina;
const { settleSeconds } = testSimConfig.net.moves;
const { kick } = testMovesConfig;
/** Seconds of sprinting that empty a full bar. */
const EMPTYING = stamina.max / stamina.drain;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  use: false,
  secondary: false,
  interact: false,
};

/** One blind chaser that stays where it is put. */
const entities = {
  ...testEntitiesConfig,
  chaser: {
    ...testEntitiesConfig.chaser,
    sightRange: 0,
    wanderSpeed: 0,
    spawn: { ...testEntitiesConfig.chaser.spawn, count: 1 },
  },
};

/** Where the host's player stands, out of the way. */
const HOST = { x: 150, y: 500 };
/** Where the guests start, with open floor to their right. */
const GUEST = { x: 100, y: 300 };
const OTHER = { x: 100, y: 400 };
/** Where the chaser waits, out of everyone's way. */
const AWAY = { x: 820, y: 520 };

/**
 * Sprinting back and forth along open floor, `seconds` each way, kicking ahead on steps where
 * `kicks` says to.
 */
function pacing(seconds: number, kicks = false) {
  let step = 0;
  return (game: Session): Controls => {
    const way = Math.floor((step++ * DT) / seconds) % 2 === 0 ? 1 : -1;
    return {
      ...idle,
      move: { x: way, y: 0 },
      sprint: true,
      secondary: kicks,
      aim: { x: game.local.x + 1000 * way, y: game.local.y },
    };
  };
}

/** Standing still and kicking whenever it can, turning about every half second. */
function kicking() {
  let step = 0;
  return (game: Session): Controls => {
    const way = Math.floor((step++ * DT) / 0.5) % 2 === 0 ? 1 : -1;
    return {
      ...idle,
      secondary: true,
      aim: { x: game.local.x + 1000 * way, y: game.local.y },
    };
  };
}

/**
 * A transport whose sends arrive `delayMs()` after they are sent, in the order sent, and that
 * counts the corrections, kicks and kicks shown it sends.
 */
function delayed(port: Transport, delayMs: () => number) {
  const queue: { at: number | null; send: () => void }[] = [];
  let last = 0;
  const counts = { corrections: 0, kicks: 0, shown: 0 };
  const send: Transport["send"] = (event, payload) => {
    for (const message of messages(event, payload)) {
      if (message.event !== NetEvent.CONTENT) continue;
      const json = JSON.stringify(message.payload);
      if (json.includes('"core/position"')) counts.corrections++;
      if (json.includes('"kicked"')) counts.kicks++;
      if (json.includes('"shown"')) counts.shown++;
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
    /** Stamps what was sent since last time as sent at `now`. */
    stamp(now: number): void {
      for (const item of queue)
        if (item.at === null) {
          last = Math.max(last, now + delayMs());
          item.at = last;
        }
    },
  };
}

function sessionOf(room: Room): Session {
  const state = room.state();
  if (state.kind !== "joined") throw new Error(`not joined: ${state.kind}`);
  return state.session;
}

function standAt(game: Session, at: Point): void {
  Object.assign(game.local, { ...at, prevX: at.x, prevY: at.y });
}

/** Keeps `game`'s own bar full, as a client that cheats its stamina does. */
function cheatStamina(game: Session): void {
  game.local.stamina = { value: stamina.max, exhausted: false, rested: 0 };
}

type Driver = (game: Session) => Controls;

/**
 * Clients joined in order to one room on a JSON hub, the first hosting, each standing where
 * `starts` puts it, each send arriving 60 to 180ms later, and stepped past the settle time.
 */
async function room(starts: Readonly<Record<string, Point>>) {
  const hub = createHub();
  const clock = createManualClock();
  const clients = new Map<
    string,
    { room: Room; net: ReturnType<typeof delayed> }
  >();
  let sends = 0;
  const jitter = (): number => 60 + ((sends++ * 37) % 120);
  for (const id of Object.keys(starts)) {
    const net = delayed(hub.transport(id, []).port, jitter);
    const joined = createRoom({
      localId: id,
      world: "dev",
      transport: net.port,
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
      content: [...entityContent(entities), ...moveContent(testMovesConfig)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await joined.join("PUFF", id.toUpperCase());
    net.stamp(clock.now());
    net.flush(Infinity);
    clients.set(id, { room: joined, net });
  }
  clock.advance(clock.now() + 1000);
  const client = (id: string) => {
    const found = clients.get(id);
    if (found === undefined) throw new Error(`no client ${id}`);
    return { ...found, game: () => sessionOf(found.room) };
  };
  for (const [id, at] of Object.entries(starts)) {
    const game = client(id).game();
    standAt(game, at);
    vi.spyOn(game.sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
  }
  const chaser = (id: string): WorldEntity => {
    const [found] = client(id).game().entities.values();
    if (found === undefined) throw new Error("no chaser");
    return found;
  };
  Object.assign(chaser("a"), { ...AWAY, tx: AWAY.x, ty: AWAY.y });

  /** Clients whose stamina is kept full, and who report walking whatever they do. */
  const cheats = { stamina: new Set<string>(), walk: new Set<string>() };
  /** Steps every joined client once, `drivers` by id or standing still, then a step's time. */
  function step(drivers: Readonly<Record<string, Driver>> = {}): void {
    for (const [id, { room: joined, net }] of clients) {
      if (joined.state().kind !== "joined") continue;
      const game = sessionOf(joined);
      if (cheats.stamina.has(id)) cheatStamina(game);
      updateSession(game, drivers[id]?.(game) ?? idle, DT);
      if (cheats.walk.has(id))
        movement.set(game.local, { ...movement.get(game.local), mode: "walk" });
      joined.frame(clock.now());
      net.stamp(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
    for (const { net } of clients.values()) net.flush(clock.now());
  }
  function run(
    seconds: number,
    drivers: Readonly<Record<string, Driver>> = {},
  ): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step(drivers);
  }
  run(settleSeconds + 0.5);
  return { client, chaser, cheats, step, run };
}

/** What `host` reckons of `id`'s stamina. */
function reckoned(host: Session, id: string) {
  const check = host.staminaChecks.get(id);
  if (check === undefined) throw new Error(`no reckoning of ${id}`);
  return check.stamina;
}

test("the host's reckoning follows a guest's sprint to exhaustion and its rest, a slack ahead", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  const host = client("a").game();
  const guest = client("b").game().local;
  expect(reckoned(host, "b").value).toBe(stamina.max + slack);
  const ahead: number[] = [];
  let exhausted = false;
  for (const [seconds, driver] of [
    [EMPTYING + 0.5, pacing(1)],
    [2, undefined],
    [1, pacing(1)],
    [3, undefined],
  ] as const) {
    for (let i = 0; i < seconds * 4; i++) {
      run(0.25, driver === undefined ? {} : { b: driver });
      exhausted ||= guest.stamina.exhausted;
      ahead.push(reckoned(host, "b").value - guest.stamina.value);
    }
  }
  expect(exhausted).toBe(true);
  expect(Math.min(...ahead)).toBeGreaterThan(0);
  expect(Math.max(...ahead)).toBeLessThan(slack + stamina.drain * 0.4);
  expect(reckoned(host, "b").exhausted).toBe(false);
  expect(client("a").net.counts.corrections).toBe(0);
});

test("an honest guest that sprints itself out, kicks whenever it can, rests and does it again, is never refused or corrected", async () => {
  const { client, run } = await room({ a: HOST, b: GUEST });
  const guest = client("b").game().local;
  run(EMPTYING + 0.5, { b: pacing(1) });
  expect(guest.stamina.exhausted).toBe(true);
  run(3, { b: kicking() });
  run(2);
  run(1, { b: pacing(1) });
  run(3, { b: kicking() });
  run(EMPTYING, { b: pacing(1) });
  run(4, { b: kicking() });
  const { kicks } = client("b").net.counts;
  expect(kicks).toBeGreaterThanOrEqual(5);
  expect(client("a").net.counts.shown).toBe(kicks);
  expect(client("a").net.counts.corrections).toBe(0);
});

test("a guest that keeps sprinting past its stamina is held to a walk, and its kicks are refused", async () => {
  const { client, cheats, run } = await room({ a: HOST, b: GUEST });
  const host = client("a").game();
  cheats.stamina.add("b");
  run(EMPTYING, { b: pacing(1) });
  expect(client("a").net.counts.corrections).toBe(0);
  run(2, { b: pacing(1) });
  expect(reckoned(host, "b").exhausted).toBe(true);
  expect(client("a").net.counts.corrections).toBeGreaterThan(0);
  const shown = client("a").net.counts.shown;
  run(1, { b: pacing(0.5, true) });
  expect(client("b").net.counts.kicks).toBeGreaterThan(0);
  expect(client("a").net.counts.shown).toBe(shown);
});

test("a guest that says it walks while it moves at a sprint is held to a walk once its stamina would be spent", async () => {
  const { client, cheats, run } = await room({ a: HOST, b: GUEST });
  cheats.stamina.add("b");
  cheats.walk.add("b");
  run(EMPTYING - 0.5, { b: pacing(1) });
  expect(client("a").net.counts.corrections).toBe(0);
  run(4, { b: pacing(1) });
  expect(reckoned(client("a").game(), "b").exhausted).toBe(true);
  expect(client("a").net.counts.corrections).toBeGreaterThan(0);
});

test("a kick the host reckons the guest cannot afford is turned down and confirmed, so the guest's prediction lets go", async () => {
  const { client, chaser, cheats, run, step } = await room({
    a: HOST,
    b: GUEST,
  });
  const facingRight = (game: Session): Controls => ({
    ...idle,
    aim: { x: game.local.x + 1000, y: game.local.y },
  });
  cheats.stamina.add("b");
  run(EMPTYING + 0.5, { b: pacing(1) });
  run(1, { b: facingRight });
  const guest = client("b").game();
  const target = {
    x: guest.local.x + testSimConfig.player.radius * 2 + kick.reach,
    y: guest.local.y,
  };
  expect(isAreaFree(guest.world.map, target.x, target.y, 15)).toBe(true);
  Object.assign(chaser("a"), { ...target, tx: target.x, ty: target.y });
  run(0.5, { b: facingRight });
  Object.assign(chaser("b"), { ...target, prevX: target.x, prevY: target.y });
  const health = chaser("a").health;
  step({ b: (game) => ({ ...facingRight(game), secondary: true }) });
  expect(guest.predictions.size).toBe(1);
  run(0.4);
  expect(chaser("a").health).toBe(health);
  expect(guest.predictions.size).toBe(0);
});

test("a new host reckons every player's stamina full, then holds them to it", async () => {
  const { client, cheats, run } = await room({
    a: HOST,
    b: GUEST,
    c: OTHER,
  });
  cheats.stamina.add("c");
  run(EMPTYING + 1, { c: pacing(1) });
  expect(reckoned(client("a").game(), "c").exhausted).toBe(true);
  await client("a").room.leave();
  run(1.5);
  expect(client("b").room.hostId()).toBe("b");
  const newHost = client("b").game();
  expect(reckoned(newHost, "c").value).toBe(stamina.max + slack);
  run(EMPTYING - 0.5, { c: pacing(1) });
  expect(client("b").net.counts.corrections).toBe(0);
  run(2, { c: pacing(1) });
  expect(reckoned(newHost, "c").exhausted).toBe(true);
  expect(client("b").net.counts.corrections).toBeGreaterThan(0);
});
