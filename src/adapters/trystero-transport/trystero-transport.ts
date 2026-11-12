import { joinRoom } from "@trystero-p2p/supabase";
import type {
  MessageAction,
  Room as TrysteroRoom,
} from "@trystero-p2p/supabase";
import { z } from "zod";
import type { GreetingConfig, NetEvent, Transport } from "../../net/index.js";

/** How the transport tells, and when, a message that introduces the sender. */
export interface Greeting extends GreetingConfig {
  /** Whether a message the sender sends introduces it. */
  readonly greets: (event: NetEvent, payload: unknown) => boolean;
  /** Milliseconds, for `replayMs`. */
  readonly now: () => number;
}

export interface TrysteroTransportOptions {
  /** Supabase project URL: peers find each other over its Realtime channels. */
  readonly url: string;
  readonly publishableKey: string;
  /** STUN and TURN servers for the peer connections; null keeps Trystero's public STUN servers. */
  readonly iceServers: readonly RTCIceServer[] | null;
  readonly greeting: Greeting;
}

/** The part of a Trystero room the transport uses: one action, peers joining, and leaving. */
export type Mesh = Pick<TrysteroRoom, "leave" | "onPeerJoin"> & {
  readonly makeAction: (namespace: string) => MessageAction<string>;
};

/**
 * Transport over WebRTC data channels between every pair of players, set up by Trystero.
 * Supabase Realtime only introduces peers and carries their connection setup; room messages
 * go straight to each connected peer, as JSON. A message reaches the peers connected when it
 * is sent and still connected once it is through. The latest greeting also reaches, within
 * `replayMs` of it, each peer that connects for the first time. `events` is an enum-like
 * object of room event names; envelopes naming any other event are dropped.
 */
export function createTrysteroTransport<E extends NetEvent>(
  events: Readonly<Record<string, E>>,
  options: TrysteroTransportOptions,
): Transport {
  return createMeshTransport(
    events,
    (room) =>
      joinRoom(
        {
          appId: options.url,
          relayConfig: { supabaseKey: options.publishableKey },
          ...(options.iceServers === null
            ? {}
            : { rtcConfig: { iceServers: [...options.iceServers] } }),
        },
        room,
      ),
    options.greeting,
  );
}

/** The transport over the meshes `joinMesh` joins. */
export function createMeshTransport<E extends NetEvent>(
  events: Readonly<Record<string, E>>,
  joinMesh: (room: string) => Mesh,
  greeting: Greeting,
): Transport {
  const Envelope = z.tuple([z.enum(events), z.unknown()]);
  let mesh: Mesh | null = null;
  let action: MessageAction<string> | null = null;
  let greeted: { envelope: string; at: number } | null = null;
  const met = new Set<string>();

  /** Sends to every connected peer, or only `target`; a peer that drops on the way misses it. */
  async function deliver(
    net: MessageAction<string>,
    envelope: string,
    target?: string,
  ): Promise<void> {
    try {
      await net.send(envelope, target === undefined ? {} : { target });
    } catch {
      // The peers still connected have it.
    }
  }

  function decode(data: string): z.infer<typeof Envelope> | null {
    try {
      const parsed = Envelope.safeParse(JSON.parse(data));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async function leave(): Promise<void> {
    if (mesh === null) return;
    const leaving = mesh;
    mesh = null;
    action = null;
    greeted = null;
    met.clear();
    await leaving.leave();
  }

  return {
    label: "online p2p",

    async join(room, handlers) {
      await leave();
      const joined = joinMesh(room);
      const net = joined.makeAction("net");
      net.onMessage = (data) => {
        const message = decode(data);
        if (message !== null) handlers[message[0]]?.(message[1]);
      };
      joined.onPeerJoin = (peer) => {
        if (met.has(peer)) return;
        met.add(peer);
        if (
          greeted !== null &&
          greeting.now() - greeted.at <= greeting.replayMs
        )
          void deliver(net, greeted.envelope, peer);
      };
      mesh = joined;
      action = net;
    },

    leave,

    async send(event, payload) {
      if (action === null) return;
      const envelope = JSON.stringify([event, payload]);
      if (greeting.greets(event, payload))
        greeted = { envelope, at: greeting.now() };
      await deliver(action, envelope);
    },
  };
}
