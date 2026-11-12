import { expect, test, vi } from "vitest";
import type { MessageAction } from "@trystero-p2p/supabase";
import { createMeshTransport } from "./trystero-transport.js";
import type { Mesh } from "./trystero-transport.js";
import { NetEvent, carries } from "../../net/index.js";
import type { Transport } from "../../net/index.js";

interface FakeMember {
  readonly room: string;
  readonly mesh: Mesh;
  receive: ((data: string, from: string) => void) | null;
  readonly peers: Set<string>;
  left: boolean;
}

/**
 * Meshes that connect only when told to, as Trystero's peers do some time after joining. A
 * send reaches the peers connected at the time, or only its target.
 */
function fakeMeshes() {
  const members = new Map<string, FakeMember>();
  let next = 0;

  function join(room: string): { id: string; joinMesh: Mesh } {
    const id = `peer${String(next++)}`;
    const member: FakeMember = {
      room,
      receive: null,
      peers: new Set(),
      left: false,
      mesh: {
        onPeerJoin: null,
        leave: vi.fn(() => {
          member.left = true;
          for (const peer of member.peers) members.get(peer)?.peers.delete(id);
          return Promise.resolve();
        }),
        makeAction: () => {
          const action: MessageAction<string> = {
            onMessage: null,
            onReceiveProgress: null,
            onReceive: null,
            send: (data, options) => {
              const targets =
                typeof options?.target === "string"
                  ? [options.target]
                  : [...member.peers];
              for (const target of targets)
                members.get(target)?.receive?.(data, id);
              return Promise.resolve();
            },
          };
          member.receive = (data, from) => {
            void action.onMessage?.(data, { peerId: from });
          };
          return action;
        },
      },
    };
    members.set(id, member);
    return { id, joinMesh: member.mesh };
  }

  /** Connects every two members of `room` that are not yet connected. */
  function connect(room: string): void {
    const inRoom = [...members.entries()].filter(
      ([, member]) => member.room === room && !member.left,
    );
    for (const [a, first] of inRoom)
      for (const [b, second] of inRoom) {
        if (a >= b || first.peers.has(b)) continue;
        first.peers.add(b);
        second.peers.add(a);
        first.mesh.onPeerJoin?.(b);
        second.mesh.onPeerJoin?.(a);
      }
  }

  return { join, connect, members };
}

function setup() {
  const meshes = fakeMeshes();
  let time = 0;
  const transport = (): Transport =>
    createMeshTransport(NetEvent, (room) => meshes.join(room).joinMesh, {
      replayMs: 1000,
      greets: (event, payload) => carries(event, payload, NetEvent.HELLO),
      now: () => time,
    });
  const at = (now: number): void => {
    time = now;
  };
  return { meshes, transport, at };
}

test("delivers to connected peers in the room as JSON, not to the sender", async () => {
  const { meshes, transport } = setup();
  const alice = transport();
  const bob = transport();
  const aliceGot = vi.fn();
  const bobGot = vi.fn();
  await alice.join("ROOM1", { [NetEvent.STATE]: aliceGot });
  await bob.join("ROOM1", { [NetEvent.STATE]: bobGot });
  meshes.connect("ROOM1");

  await alice.send(NetEvent.STATE, { x: 1, gone: undefined, at: new Date(0) });

  expect(bobGot).toHaveBeenCalledWith({ x: 1, at: "1970-01-01T00:00:00.000Z" });
  expect(aliceGot).not.toHaveBeenCalled();
});

test("the latest greeting, alone or in a batch, is sent again to each peer that connects for the first time", async () => {
  const { meshes, transport, at } = setup();
  const alice = transport();
  const bob = transport();
  const bobBatch = vi.fn();
  const bobState = vi.fn();
  await alice.join("ROOM1", {});
  await bob.join("ROOM1", {
    [NetEvent.BATCH]: bobBatch,
    [NetEvent.STATE]: bobState,
  });
  const greeting = {
    messages: [
      [NetEvent.HELLO, { id: "a" }],
      [NetEvent.STATE, { id: "a" }],
    ],
  };
  at(100);
  await alice.send(NetEvent.BATCH, greeting);
  await alice.send(NetEvent.STATE, { id: "a" });
  at(900);
  meshes.connect("ROOM1");
  expect(bobBatch).toHaveBeenCalledExactlyOnceWith(greeting);
  expect(bobState).not.toHaveBeenCalled();

  const carolBatch = vi.fn();
  const carol = transport();
  await carol.join("ROOM1", { [NetEvent.BATCH]: carolBatch });
  meshes.connect("ROOM1");
  expect(bobBatch).toHaveBeenCalledOnce();
  expect(carolBatch).toHaveBeenCalledExactlyOnceWith(greeting);
});

test("past the replay window a new peer is not greeted", async () => {
  const { meshes, transport, at } = setup();
  const alice = transport();
  const bob = transport();
  const bobHello = vi.fn();
  await alice.join("ROOM1", {});
  await alice.send(NetEvent.HELLO, { id: "a" });
  at(1001);
  await bob.join("ROOM1", { [NetEvent.HELLO]: bobHello });
  meshes.connect("ROOM1");
  expect(bobHello).not.toHaveBeenCalled();
});

test("rooms are isolated, and envelopes that are no message are dropped", async () => {
  const { meshes, transport } = setup();
  const alice = transport();
  const bob = transport();
  const bobGot = vi.fn();
  await alice.join("ROOM1", {});
  await bob.join("ROOM2", { [NetEvent.STATE]: bobGot });
  meshes.connect("ROOM1");
  meshes.connect("ROOM2");
  await alice.send(NetEvent.STATE, {});
  expect(bobGot).not.toHaveBeenCalled();

  const carol = transport();
  await carol.join("ROOM2", {});
  meshes.connect("ROOM2");
  for (const member of meshes.members.values())
    if (member.room === "ROOM2") {
      member.receive?.("not json", "x");
      member.receive?.(JSON.stringify(["nonsense", 1]), "x");
      member.receive?.(JSON.stringify({ event: NetEvent.STATE }), "x");
    }
  expect(bobGot).not.toHaveBeenCalled();
});

test("leaving leaves the mesh; sends outside a room do nothing; joining again leaves first", async () => {
  const { meshes, transport } = setup();
  const alice = transport();
  await alice.send(NetEvent.STATE, {});
  await alice.join("ROOM1", {});
  await alice.join("ROOM2", {});
  const [first, second] = [...meshes.members.values()];
  expect(first?.mesh.leave).toHaveBeenCalledOnce();
  await alice.leave();
  await alice.leave();
  expect(second?.mesh.leave).toHaveBeenCalledOnce();
  expect(alice.label).toBe("online p2p");
});

test("a peer that drops while a message is on its way does not fail the send", async () => {
  const meshes = fakeMeshes();
  const transport = createMeshTransport(
    NetEvent,
    (room) => {
      const mesh = meshes.join(room).joinMesh;
      return {
        ...mesh,
        makeAction: (namespace) => ({
          ...mesh.makeAction(namespace),
          send: () => Promise.reject(new Error("peer disconnected")),
        }),
      };
    },
    { replayMs: 1000, greets: () => false, now: () => 0 },
  );
  await transport.join("ROOM1", {});
  await expect(transport.send(NetEvent.STATE, {})).resolves.toBeUndefined();
});
