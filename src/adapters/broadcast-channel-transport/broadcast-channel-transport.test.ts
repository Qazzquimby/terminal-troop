import { afterEach, expect, expectTypeOf, test, vi } from "vitest";
import { createBroadcastChannelTransport } from "./broadcast-channel-transport.js";
import { NET_EVENTS, NetEvent } from "../../net/index.js";
import type { Transport } from "../../net/index.js";

const open: Transport[] = [];

function transport(): Transport {
  const created = createBroadcastChannelTransport(NET_EVENTS);
  open.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.leave()));
});

/** BroadcastChannel delivers on a later task; give it a few. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("delivers to other members of the room, not to the sender", async () => {
  const alice = transport();
  const bob = transport();
  const aliceGot = vi.fn();
  const bobGot = vi.fn();
  await alice.join("ROOM1", { [NetEvent.STATE]: aliceGot });
  await bob.join("ROOM1", { [NetEvent.STATE]: bobGot });

  await alice.send(NetEvent.STATE, { hello: 1 });
  await flush();

  expect(bobGot).toHaveBeenCalledWith({ hello: 1 });
  expect(aliceGot).not.toHaveBeenCalled();
});

test("rooms are isolated", async () => {
  const alice = transport();
  const bob = transport();
  const bobGot = vi.fn();
  await alice.join("ROOM1", {});
  await bob.join("ROOM2", { [NetEvent.STATE]: bobGot });

  await alice.send(NetEvent.STATE, {});
  await flush();

  expect(bobGot).not.toHaveBeenCalled();
});

test("routes each event to its own handler", async () => {
  const alice = transport();
  const bob = transport();
  const hello = vi.fn();
  const bye = vi.fn();
  await alice.join("ROOM1", {});
  await bob.join("ROOM1", { [NetEvent.HELLO]: hello, [NetEvent.BYE]: bye });

  await alice.send(NetEvent.BYE, { id: "a" });
  await flush();

  expect(bye).toHaveBeenCalledWith({ id: "a" });
  expect(hello).not.toHaveBeenCalled();
});

test("stops receiving after leave, and sending outside a room is a no-op", async () => {
  const alice = transport();
  const bob = transport();
  const bobGot = vi.fn();
  await alice.join("ROOM1", {});
  await bob.join("ROOM1", { [NetEvent.STATE]: bobGot });

  await bob.leave();
  await alice.send(NetEvent.STATE, {});
  await bob.send(NetEvent.STATE, {});
  await flush();

  expect(bobGot).not.toHaveBeenCalled();
});

test("ignores messages that are not transport envelopes", async () => {
  const bob = transport();
  const bobGot = vi.fn();
  await bob.join("ROOM1", { [NetEvent.STATE]: bobGot });

  const stray = new BroadcastChannel("terminal-troop:ROOM1");
  stray.postMessage({ event: "nope", payload: {} });
  stray.postMessage("garbage");
  await flush();
  stray.close();

  expect(bobGot).not.toHaveBeenCalled();
});

test("drops event names outside the given list and dispatches listed ones", async () => {
  const bob = createBroadcastChannelTransport([NetEvent.STATE]);
  open.push(bob);
  const state = vi.fn();
  const hello = vi.fn();
  await bob.join("ROOM1", { [NetEvent.STATE]: state, [NetEvent.HELLO]: hello });

  const sender = new BroadcastChannel("terminal-troop:ROOM1");
  sender.postMessage({ event: NetEvent.HELLO, payload: { id: "a" } });
  sender.postMessage({ event: "unknown", payload: { id: "a" } });
  sender.postMessage({ event: NetEvent.STATE, payload: { id: "a" } });
  await flush();
  sender.close();

  expect(hello).not.toHaveBeenCalled();
  expect(state).toHaveBeenCalledOnce();
  expect(state).toHaveBeenCalledWith({ id: "a" });
});

test("accepts only NetEvent names as its event list", () => {
  expectTypeOf(createBroadcastChannelTransport)
    .parameter(0)
    .toEqualTypeOf<readonly [NetEvent, ...NetEvent[]]>();
});
