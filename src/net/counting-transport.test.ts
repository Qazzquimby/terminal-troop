import { expect, test, vi } from "vitest";
import { NetEvent } from "./transport.js";
import { createCountingTransport } from "./counting-transport.js";
import type { Transport } from "./transport.js";

type Handlers = Parameters<Transport["join"]>[1];

/** Records what it is given; `deliver` plays a message from another room member. */
function fakeTransport() {
  let joined: Handlers = {};
  const sent: { event: NetEvent; payload: unknown }[] = [];
  const transport: Transport = {
    label: "fake",
    join: (_room, handlers) => {
      joined = handlers;
      return Promise.resolve();
    },
    leave: vi.fn(() => Promise.resolve()),
    send: (event, payload) => {
      sent.push({ event, payload });
      return Promise.resolve();
    },
  };
  const deliver = (event: NetEvent, payload: unknown): void => {
    joined[event]?.(payload);
  };
  return { transport, sent, deliver };
}

function setup() {
  const fake = fakeTransport();
  let time = 0;
  const counted = createCountingTransport(fake.transport, () => time);
  const at = (now: number): void => {
    time = now;
  };
  return { ...fake, counted, at };
}

test("passes sends through unchanged and counts them", async () => {
  const { counted, sent, at } = setup();
  const payload = { id: "a", x: 1 };

  at(100);
  await counted.transport.send(NetEvent.STATE, payload);
  at(200);
  await counted.transport.send(NetEvent.HELLO, { id: "a" });

  expect(sent).toEqual([
    { event: NetEvent.STATE, payload },
    { event: NetEvent.HELLO, payload: { id: "a" } },
  ]);
  expect(sent[0]?.payload).toBe(payload);
  expect(counted.rates(200)).toEqual({ sentPerS: 2, receivedPerS: 0 });
});

test("passes received payloads to the joined handlers and counts them", async () => {
  const { counted, deliver, at } = setup();
  const onState = vi.fn();
  const onBye = vi.fn();
  await counted.transport.join("ROOM1", {
    [NetEvent.STATE]: onState,
    [NetEvent.BYE]: onBye,
  });
  const payload = { id: "b" };

  at(50);
  deliver(NetEvent.STATE, payload);
  deliver(NetEvent.STATE, payload);
  deliver(NetEvent.BYE, { id: "b" });

  expect(onState).toHaveBeenCalledTimes(2);
  expect(onState).toHaveBeenCalledWith(payload);
  expect(onBye).toHaveBeenCalledWith({ id: "b" });
  expect(counted.rates(50)).toEqual({ sentPerS: 0, receivedPerS: 3 });
});

test("rates cover the last second only", async () => {
  const { counted, at } = setup();
  for (let now = 0; now < 2000; now += 100) {
    at(now);
    await counted.transport.send(NetEvent.STATE, {});
  }

  expect(counted.rates(1900).sentPerS).toBe(10);
  expect(counted.rates(5000).sentPerS).toBe(0);
});

test("keeps the label and delegates leave", async () => {
  const { counted, transport } = setup();
  expect(counted.transport.label).toBe("fake");
  await counted.transport.leave();
  expect(transport.leave).toHaveBeenCalledOnce();
});
