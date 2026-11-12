import { expect, test, vi } from "vitest";
import { createBatchingTransport, unbatch } from "./batching-transport.js";
import { NetEvent } from "./transport.js";
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

test("outside a batch each message goes out at once, as itself", async () => {
  const { transport, sent } = fakeTransport();
  const batching = createBatchingTransport(transport);
  await batching.transport.send(NetEvent.HELLO, { id: "a" });
  expect(sent).toEqual([{ event: NetEvent.HELLO, payload: { id: "a" } }]);
});

test("what a batch sends goes out after it as one broadcast, in order; nested batches join it", () => {
  const { transport, sent } = fakeTransport();
  const { transport: batched, batch } = createBatchingTransport(transport);
  const result = batch(() => {
    void batched.send(NetEvent.STATE, { id: "a" });
    batch(() => {
      void batched.send(NetEvent.CONTENT, { n: 1 });
    });
    expect(sent).toEqual([]);
    void batched.send(NetEvent.ENTITIES, { n: 2 });
    return "done";
  });
  expect(result).toBe("done");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.event).toBe(NetEvent.BATCH);
  expect(unbatch(sent[0]?.payload)).toEqual([
    { event: NetEvent.STATE, payload: { id: "a" } },
    { event: NetEvent.CONTENT, payload: { n: 1 } },
    { event: NetEvent.ENTITIES, payload: { n: 2 } },
  ]);
});

test("a batch of one sends it as itself, and a batch of none sends nothing", () => {
  const { transport, sent } = fakeTransport();
  const { transport: batched, batch } = createBatchingTransport(transport);
  batch(() => undefined);
  batch(() => {
    void batched.send(NetEvent.HEARTBEAT, { id: "a" });
  });
  expect(sent).toEqual([{ event: NetEvent.HEARTBEAT, payload: { id: "a" } }]);
});

test("a batch that throws still sends what it held", () => {
  const { transport, sent } = fakeTransport();
  const { transport: batched, batch } = createBatchingTransport(transport);
  expect(() =>
    batch(() => {
      void batched.send(NetEvent.BYE, { id: "a" });
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(sent).toEqual([{ event: NetEvent.BYE, payload: { id: "a" } }]);
});

test("a received batch reaches each handler in order, leaving out entries that are no message", async () => {
  const { transport, deliver } = fakeTransport();
  const { transport: batched } = createBatchingTransport(transport);
  const heard: string[] = [];
  await batched.join("ROOM", {
    [NetEvent.STATE]: (payload) => heard.push(`state ${String(payload)}`),
    [NetEvent.BYE]: (payload) => heard.push(`bye ${String(payload)}`),
  });
  deliver(NetEvent.BATCH, {
    messages: [
      [NetEvent.STATE, 1],
      ["nonsense", 2],
      [NetEvent.BATCH, { messages: [[NetEvent.BYE, 3]] }],
      { event: NetEvent.BYE },
      [NetEvent.BYE, 4],
      [NetEvent.HELLO, 5],
    ],
  });
  deliver(NetEvent.BATCH, { not: "a batch" });
  expect(heard).toEqual(["state 1", "bye 4"]);
});

test("what handlers send while a batch is received goes out as one broadcast", async () => {
  const { transport, sent, deliver } = fakeTransport();
  const { transport: batched } = createBatchingTransport(transport);
  await batched.join("ROOM", {
    [NetEvent.HELLO]: () => {
      void batched.send(NetEvent.STATE, "reply");
    },
  });
  deliver(NetEvent.BATCH, {
    messages: [
      [NetEvent.HELLO, {}],
      [NetEvent.HELLO, {}],
    ],
  });
  expect(sent).toHaveLength(1);
  expect(unbatch(sent[0]?.payload)).toHaveLength(2);
});

test("keeps the label and delegates leave", async () => {
  const { transport } = fakeTransport();
  const { transport: batched } = createBatchingTransport(transport);
  expect(batched.label).toBe("fake");
  await batched.leave();
  expect(transport.leave).toHaveBeenCalledOnce();
});
