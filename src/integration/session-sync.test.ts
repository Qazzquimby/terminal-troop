import { afterEach, expect, test } from "vitest";
import { createBroadcastChannelTransport } from "../adapters/broadcast-channel-transport/index.js";
import {
  randomFreePosition,
  createSession,
  receiveState,
  sendState,
  updateSession,
} from "../sim/index.js";
import { NetEvent } from "../net/index.js";
import type { Session } from "../sim/index.js";
import type { Transport } from "../net/index.js";
import { testSfx, testSimConfig } from "./sim-config.js";

const ROOM = "SYNC1";
const open: Transport[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.leave()));
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** A session wired to the room the way bootstrap.ts wires it. */
async function client(
  id: string,
): Promise<{ session: Session; transport: Transport }> {
  const transport = createBroadcastChannelTransport(NetEvent);
  open.push(transport);
  const session = createSession(
    id,
    id.toUpperCase(),
    ROOM,
    "standard",
    testSfx(),
    testSimConfig,
  );
  await transport.join(ROOM, {
    [NetEvent.STATE]: (payload) => {
      receiveState(session, payload);
    },
    [NetEvent.HELLO]: () => {
      sendState(session, transport, performance.now(), true);
    },
  });
  return { session, transport };
}

const idle = { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, sprint: false };

test("clients in the same room build the same world", async () => {
  const a = await client("a");
  const b = await client("b");
  expect(a.session.world.map.solid).toEqual(b.session.world.map.solid);
});

test("a joining client learns about existing players through HELLO", async () => {
  const a = await client("a");
  const b = await client("b");

  await b.transport.send(NetEvent.HELLO, { id: "b" });
  await flush();

  const seen = b.session.players.get("a");
  expect(seen?.name).toBe("A");
  expect(seen?.x).toBe(a.session.local.x);
  expect(seen?.y).toBe(a.session.local.y);
});

test("remote players are smoothed toward their latest reported position", async () => {
  const a = await client("a");
  const b = await client("b");
  sendState(a.session, a.transport, 0, true);
  await flush();

  // Reports inside a wall are rejected, so move to another known-free spot.
  const target = randomFreePosition(a.session.world, a.session.local.radius);
  a.session.local.x = target.x;
  a.session.local.y = target.y;
  sendState(a.session, a.transport, 1000, true);
  await flush();

  const remote = b.session.players.get("a");
  if (remote === undefined) throw new Error("b never saw a");
  expect({ x: remote.tx, y: remote.ty }).toEqual(target);
  const gapBefore = Math.hypot(target.x - remote.x, target.y - remote.y);

  updateSession(b.session, idle, 1 / 60, performance.now());
  const gapAfter = Math.hypot(target.x - remote.x, target.y - remote.y);
  expect(gapAfter).toBeLessThan(gapBefore);
  expect(gapAfter).toBeGreaterThan(0);
});

test("state sends are throttled unless forced", async () => {
  const a = await client("a");
  const b = await client("b");
  const sentX = a.session.local.x;
  sendState(a.session, a.transport, 1000, true);
  a.session.local.x += 5;
  sendState(a.session, a.transport, 1001);
  await flush();

  expect(b.session.players.get("a")?.tx).toBe(sentX);
});
