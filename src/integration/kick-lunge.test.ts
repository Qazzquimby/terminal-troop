import { expect, test, vi } from "vitest";
import { entityContent } from "../entities/index.js";
import { createScope } from "../lib/scope/index.js";
import { moveContent } from "../moves/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import { createRoom } from "../room/index.js";
import type { Room } from "../room/index.js";
import { updateSession } from "../sim/index.js";
import type { Controls, Point, Session, WorldEntity } from "../sim/index.js";
import { createNullVoice } from "../voice/index.js";
import {
  addressOf,
  createHub,
  createManualClock,
  KICK,
  messages,
  showsKick,
  testRoomConfig,
} from "./room-helpers.js";
import { teleport } from "./crew.js";
import {
  testEntitiesConfig,
  testMovesConfig,
  testSfx,
  testSimConfig,
} from "./sim-config.js";

const DT = 1 / 60;
const PLAYER_LENGTH = testSimConfig.player.radius * 2;
const idle: Controls = {
  move: { x: 0, y: 0 },
  aim: { x: 0, y: 0 },
  sprint: false,
  crouch: false,
  select: null,
  cycle: 0,
  use: false,
  secondary: false,
  interact: false,
  drop: false,
  holdingUse: false,
};

/** Kicks that cost next to no stamina, so only their cooldown holds them back. */
const moves = {
  kick: { ...testMovesConfig.kick, stamina: 1 },
};
const { kick } = moves;

/** `count` blind zombies wandering the dev square, in the way of lunges where each client sees them. */
const blindZombies = (count: number) => ({
  ...testEntitiesConfig,
  zombie: {
    ...testEntitiesConfig.zombie,
    sightRange: 0,
    spawn: { ...testEntitiesConfig.zombie.spawn, count, clearance: 100 },
  },
});

const HOST = { x: 450, y: 150 };
const GUEST = { x: 150, y: 300 };

/**
 * A transport whose sends arrive `delayMs()` after they are sent, in the order sent, and that
 * counts the kicks and kicks shown it sends.
 */
function delayed(port: Transport, delayMs: () => number) {
  const queue: { at: number | null; send: () => void }[] = [];
  let last = 0;
  const counts = { kicks: 0, shown: 0 };
  const send: Transport["send"] = (event, payload) => {
    for (const message of messages(event, payload)) {
      if (message.event !== NetEvent.CONTENT) continue;
      const address = addressOf(message.payload);
      if (address === KICK) counts.kicks++;
      if (showsKick(message.payload)) counts.shown++;
    }
    queue.push({ at: null, send: () => void port.send(event, payload) });
    return Promise.resolve();
  };
  return {
    port: { ...port, send },
    counts,
    /** Delivers what is due by `now`. */
    flush(now: number): void {
      while (queue[0]?.at != null && queue[0].at <= now) queue.shift()?.send();
    },
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

type Driver = (game: Session, time: number) => Controls;

/**
 * A host and a guest joined to one room on a JSON hub with `zombies` blind zombies, each send
 * arriving 60 to 180ms later, each player at its spot. The guest's frames,
 * which send what it has to send, come every one to three steps, as a browser's do when they
 * fall behind the sim.
 */
async function room(zombies = 4) {
  const hub = createHub();
  const clock = createManualClock();
  const clients = new Map<
    string,
    { room: Room; net: ReturnType<typeof delayed> }
  >();
  let sends = 0;
  const jitter = (): number => 60 + ((sends++ * 37) % 120);
  for (const id of ["a", "b"]) {
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
      content: [...entityContent(blindZombies(zombies)), ...moveContent(moves)],
      falloff: { full: 100, silent: 600, pan: 300 },
      onChange: () => undefined,
      onPeerFailed: () => undefined,
    });
    await joined.join("LUNGE", id.toUpperCase());
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
  for (const id of ["a", "b"]) {
    const game = client(id).game();
    vi.spyOn(game.sfx, "play").mockResolvedValue({
      stop: () => undefined,
      setVolume: () => undefined,
      setPosition: () => undefined,
    });
  }

  let steps = 0;
  const unframed = new Set<string>();
  /**
   * Steps both clients once, the guest by `driver` or standing still, then a step's time.
   */
  function step(driver?: Driver): void {
    steps++;
    for (const [id, { room: joined, net }] of clients) {
      const game = sessionOf(joined);
      const controls =
        id === "b" && driver !== undefined ? driver(game, steps * DT) : idle;
      updateSession(game, controls, DT);
      if (id === "b" && steps % 5 < 3 && steps % 7 !== 0) unframed.add(id);
      else unframed.delete(id);
      if (unframed.has(id)) continue;
      joined.frame(clock.now());
      net.stamp(clock.now());
    }
    clock.advance(clock.now() + 1000 * DT);
    for (const { net } of clients.values()) net.flush(clock.now());
  }
  function run(seconds: number, driver?: Driver): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) step(driver);
  }
  run(0.5);
  const games = [client("a").game(), client("b").game()];
  teleport(games, "a", HOST);
  teleport(games, "b", GUEST);
  run(1);
  const zombie = (id: string): WorldEntity => {
    const [found] = client(id).game().entities.values();
    if (found === undefined) throw new Error("no zombie");
    return found;
  };
  return { client, zombie, run, step };
}

/** Aims at `angle` radians from where `game`'s player stands. */
const aiming = (game: Session, angle: number): Point => ({
  x: game.local.x + 1000 * Math.cos(angle),
  y: game.local.y + 1000 * Math.sin(angle),
});

/** Sprints in bursts, a short walk between so stamina keeps up, kicking whenever it can. */
const sprintKicking = (time: number, move: Point, aim: Point): Controls => ({
  ...idle,
  move,
  aim,
  sprint: time % 2 < 1.2,
  secondary: true,
});

test("a guest sprinting about the room, turning hard and kicking whenever it can, is never refused", async () => {
  const { client, run } = await room();
  const ways = [0, 1, 2, 3, 4, 5, 6, 7].map((eighth) => ({
    x: Math.cos((eighth * Math.PI) / 4),
    y: Math.sin((eighth * Math.PI) / 4),
  }));
  run(40, (game, time) =>
    sprintKicking(
      time,
      ways[Math.floor(time / 0.45) % ways.length] ?? { x: 0, y: 0 },
      aiming(game, time * 4 + 1.5 * Math.sin(time * 9)),
    ),
  );
  run(1);
  const { kicks } = client("b").net.counts;
  expect(kicks).toBeGreaterThan(50);
  expect(client("a").net.counts.shown).toBe(kicks);
});

test("a guest sprinting along a wall, kicking along and into it as it turns, is never refused", async () => {
  const { client, run } = await room();
  run(40, (game, time) => {
    const up = Math.floor(time / 1.5) % 2 === 0;
    const along = up ? -Math.PI / 2 : Math.PI / 2;
    const towardWall = up ? -1 : 1;
    const sweep = 0.25 * Math.sin(time * 11);
    return sprintKicking(
      time,
      { x: -1, y: up ? -0.4 : 0.4 },
      aiming(game, along + towardWall * sweep),
    );
  });
  run(1);
  const { kicks } = client("b").net.counts;
  expect(kicks).toBeGreaterThan(50);
  expect(client("a").net.counts.shown).toBe(kicks);
});

/** Where a kick that lunged `to` facing right lands its hitbox. */
const hitboxOf = (to: Point): Point => ({ x: to.x + kick.reach, y: to.y });

/** Faces right, kicking if `kicks`. */
const facingRight =
  (kicks: boolean): Driver =>
  (game) => ({ ...idle, secondary: kicks, aim: aiming(game, 0) });

/**
 * A guest that kicks a zombie right in front of it: whether the host took the kick, whether the
 * guest predicted a hit, and whether it still holds one.
 */
async function kickAhead() {
  const { client, zombie, run, step } = await room(1);
  const guest = client("b").game();
  run(0.5, facingRight(false));
  const target = hitboxOf({
    x: guest.local.x + PLAYER_LENGTH,
    y: guest.local.y,
  });
  for (const id of ["a", "b"])
    Object.assign(zombie(id), {
      ...target,
      prevX: target.x,
      prevY: target.y,
      tx: target.x,
      ty: target.y,
    });
  const shown = client("a").net.counts.shown;
  step(facingRight(true));
  const predicted = guest.predictions.size > 0;
  run(0.6, facingRight(false));
  return {
    landed: client("a").net.counts.shown > shown,
    predicted,
    held: guest.predictions.size > 0,
  };
}

test("a kick from where the guest stands lands, and the host's word ends its prediction", async () => {
  expect(await kickAhead()).toEqual({
    landed: true,
    predicted: true,
    held: false,
  });
});

test("a guest's kick knocks the zombie back on the step it kicks, and the guest lunges its full length", async () => {
  const { client, zombie, run, step } = await room(1);
  const guest = client("b").game();
  run(0.5, facingRight(false));
  const start = { x: guest.local.x, y: guest.local.y };
  const target = hitboxOf({ x: start.x + PLAYER_LENGTH, y: start.y });
  for (const id of ["a", "b"])
    Object.assign(zombie(id), {
      ...target,
      prevX: target.x,
      prevY: target.y,
      tx: target.x,
      ty: target.y,
    });
  const shown = client("a").net.counts.shown;
  step(facingRight(true));
  const zombieLength = testEntitiesConfig.zombie.radius * 2;
  expect(zombie("b").x - target.x).toBeGreaterThan(
    zombieLength * kick.knockback - 5,
  );
  run(kick.lunge.seconds + 0.5, facingRight(false));
  expect(guest.local.x - start.x).toBeCloseTo(PLAYER_LENGTH, 0);
  expect(guest.local.y).toBeCloseTo(start.y, 0);
  expect(client("a").net.counts.shown).toBe(shown + 1);
});

test("a guest sprinting and turning about the room for a minute, kicking whenever it can, is never refused", async () => {
  const { client, run } = await room();
  run(60, (game, time) =>
    sprintKicking(
      time,
      {
        x: Math.cos(Math.floor(time / 0.6) * 2.4),
        y: Math.sin(Math.floor(time / 0.6) * 2.4),
      },
      aiming(game, time * 5 + 2 * Math.sin(time * 7)),
    ),
  );
  run(1);
  const { kicks } = client("b").net.counts;
  expect(kicks).toBeGreaterThan(80);
  expect(client("a").net.counts.shown).toBe(kicks);
});
