import type { SignalMessage } from "./signal.js";
import {
  isPolite,
  opensNegotiation,
  sameDescription,
  signalFor,
} from "./signal.js";
import type {
  PeerDiagnostics,
  Voice,
  VoiceConnectionConfig,
  VoiceRoom,
  VoiceSettings,
} from "../../voice/index.js";
import { createScope } from "../../lib/scope/index.js";
import type { Scope } from "../../lib/scope/index.js";
import { createMicCapture } from "./mic-capture.js";
import { createPeerLevels } from "./peer-levels.js";
import { disposeQuietly, later } from "./scopes.js";
import { connectionStats } from "./stats.js";
import type { ConnectionStats } from "./stats.js";
import {
  connDecision,
  createPendingSignals,
  diffPeers,
  nextBackoff,
} from "./reconcile.js";
import { isTransmitting } from "./transmit.js";

/** Where voice plays: the shared AudioContext, and the node incoming voice connects to. */
interface VoiceAudio {
  audioContext: () => AudioContext;
  output: () => AudioNode;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** One RTCPeerConnection to a peer, and the playback nodes fed by it. */
interface Connection {
  /** Our name for this connection, sent with every signal from it. */
  readonly conn: string;
  /** The other side's name for its end, once a signal carried it. */
  remoteConn: string | null;
  readonly scope: Scope;
  readonly pc: RTCPeerConnection;
  readonly polite: boolean;
  readonly gain: GainNode;
  readonly panner: StereoPannerNode;
  /** Chrome feeds WebAudio silence from a WebRTC stream unless a media element also plays it. */
  readonly sink: HTMLAudioElement;
  source: MediaStreamAudioSourceNode | null;
  makingOffer: boolean;
  ignoreOffer: boolean;
  /** The connection state last seen, and since when. */
  seen: { state: RTCPeerConnectionState; since: number };
  stats: StatsReading;
}

/** The latest statistics of a connection, and when they were asked for. */
interface StatsReading extends ConnectionStats {
  receiving: boolean;
  askedAt: number;
  asking: boolean;
}

/** A peer voice wants a connection with; between attempts it has none. */
interface Peer {
  readonly scope: Scope;
  connection: Connection | null;
  /** The wait before the latest retry, or null since the last success. */
  backoffMs: number | null;
  /** Attempts that failed since the last success. */
  failures: number;
  /** When the peer was last left without a connection. */
  idleSince: number;
}

/** A room that can also redo one peer's connection. */
interface JoinedRoom extends VoiceRoom {
  retry(id: string): void;
}

/** Why a connection opens: on our own, or to take up an offer or a ready from the peer. */
type Opener = "self" | "offer" | "ready";

type Signal =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit }
  | { ready: true };

/**
 * Voice over WebRTC: a mesh with one RTCPeerConnection per wanted remote player, set up
 * through SIGNAL messages using the "perfect negotiation" pattern.
 *
 * Playback: remote stream -> source -> per-peer gain -> panner -> voice volume -> `output`.
 * The per-peer gain is the mix volume, or 0 while that player is muted.
 */
export function createWebRtcVoice(
  audio: VoiceAudio,
  initial: VoiceSettings,
  config: VoiceConnectionConfig,
): Voice {
  const { audioContext } = audio;
  const levels = createPeerLevels();
  /** The peers of the room joined now, by id. */
  let peers = new Map<string, Peer>();
  let talking = false;
  let testing = false;
  let { mode, muted, volume } = initial;
  let voiceVolume: GainNode | null = null;
  let room: JoinedRoom | null = null;
  const mic = createMicCapture(audioContext, initial.inputDevice, () => {
    applyTransmit();
  });

  function volumeGain(): GainNode {
    if (voiceVolume === null) {
      voiceVolume = audioContext().createGain();
      voiceVolume.gain.value = volume;
      voiceVolume.connect(audio.output());
    }
    return voiceVolume;
  }

  function transmitting(): boolean {
    return mic.track() !== null && isTransmitting(mode, talking, muted);
  }

  /**
   * Puts the mic on, or takes it off, every audio line allowed to send. A disabled track
   * still sends comfort-noise packets, so silence also detaches it: nothing goes out.
   */
  function attachMic(pc: RTCPeerConnection): void {
    const track = transmitting() ? mic.track() : null;
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.direction === "sendrecv") {
        void transceiver.sender.replaceTrack(track);
      }
    }
  }

  function connections(): Connection[] {
    const all: Connection[] = [];
    peers.forEach((peer) => {
      if (peer.connection !== null) all.push(peer.connection);
    });
    return all;
  }

  /** A track that is testing stays enabled, for its meter, while off every connection. */
  function applyTransmit(): void {
    const track = mic.track();
    if (track !== null) track.enabled = transmitting() || testing;
    for (const connection of connections()) attachMic(connection.pc);
  }

  /** Sets a peer's playback nodes from its levels; does nothing for a peer without nodes. */
  function applyLevels(peerId: string): void {
    const connection = peers.get(peerId)?.connection;
    if (connection === undefined || connection === null) return;
    const { gain, pan } = levels.levels(peerId);
    const now = connection.gain.context.currentTime;
    connection.gain.gain.setTargetAtTime(gain, now, config.levelRampS);
    connection.panner.pan.setTargetAtTime(pan, now, config.levelRampS);
  }

  /** Notes a change of the connection's state, which an unexpected close makes without an event. */
  function observe(connection: Connection): void {
    const state = connection.pc.connectionState;
    if (state !== connection.seen.state) {
      connection.seen = { state, since: performance.now() };
    }
  }

  /** Asks for the connection's statistics, at most once per `statsIntervalMs`. */
  function readStats(connection: Connection, now: number): void {
    const { stats, pc } = connection;
    if (stats.asking || now - stats.askedAt < config.statsIntervalMs) return;
    if (pc.connectionState === "closed") return;
    stats.asking = true;
    stats.askedAt = now;
    pc.getStats()
      .then((report) => {
        const read = connectionStats(report);
        stats.receiving = read.bytesReceived > stats.bytesReceived;
        stats.bytesReceived = read.bytesReceived;
        stats.route = read.route;
      })
      .catch(() => undefined)
      .finally(() => {
        stats.asking = false;
      });
  }

  function diagnose(id: string, peer: Peer, now: number): PeerDiagnostics {
    const { connection, failures } = peer;
    if (connection === null) {
      return {
        id,
        state: "pending",
        ice: null,
        signaling: null,
        since: peer.idleSince,
        route: null,
        bytesReceived: 0,
        receiving: false,
        failures,
      };
    }
    observe(connection);
    readStats(connection, now);
    const { pc, seen, stats } = connection;
    return {
      id,
      state: seen.state,
      ice: pc.iceConnectionState,
      signaling: pc.signalingState,
      since: seen.since,
      route: stats.route,
      bytesReceived: stats.bytesReceived,
      receiving: stats.receiving,
      failures,
    };
  }

  function play(connection: Connection, event: RTCTrackEvent): void {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    connection.sink.srcObject = stream;
    void connection.sink.play().catch(() => undefined);
    connection.source?.disconnect();
    connection.source = audioContext().createMediaStreamSource(stream);
    connection.source.connect(connection.gain);
  }

  function join(
    localId: string,
    sendSignal: (signal: unknown) => void,
    events: { peerFailed(id: string): void },
  ): JoinedRoom {
    const scope = createScope();
    const own = new Map<string, Peer>();
    const pending = createPendingSignals(config.pending);
    peers = own;

    function send(to: string, connection: Connection, signal: Signal): void {
      if (connection.scope.disposed) return;
      sendSignal({ from: localId, to, conn: connection.conn, ...signal });
    }

    function drop(peer: Peer): void {
      const { connection } = peer;
      if (connection === null) return;
      peer.connection = null;
      peer.idleSince = performance.now();
      disposeQuietly(connection.scope);
    }

    /** Gives up on the peer's connection, and tries again after a growing wait. */
    function fail(peerId: string, peer: Peer): void {
      events.peerFailed(peerId);
      peer.failures += 1;
      drop(peer);
      if (peer.scope.disposed) return;
      const wait = nextBackoff(peer.backoffMs, config.retry);
      peer.backoffMs = wait;
      later(peer.scope, wait, () => {
        if (peer.connection === null) connect(peerId, peer, "self", null);
      });
    }

    function connect(
      peerId: string,
      peer: Peer,
      opener: Opener,
      remoteConn: string | null,
    ): Connection {
      const context = audioContext();
      const connectionScope = peer.scope.child();
      const { signal } = connectionScope;
      const gain = context.createGain();
      const panner = context.createStereoPanner();
      gain.gain.value = levels.levels(peerId).gain;
      panner.pan.value = levels.levels(peerId).pan;
      gain.connect(panner);
      panner.connect(volumeGain());
      const sink = new Audio();
      sink.muted = true;
      const pc = new RTCPeerConnection(RTC_CONFIG);

      const connection: Connection = {
        conn: crypto.randomUUID(),
        remoteConn,
        scope: connectionScope,
        pc,
        polite: isPolite(localId, peerId),
        gain,
        panner,
        sink,
        source: null,
        makingOffer: false,
        ignoreOffer: false,
        seen: { state: pc.connectionState, since: performance.now() },
        stats: {
          route: null,
          bytesReceived: 0,
          receiving: false,
          askedAt: -Infinity,
          asking: false,
        },
      };
      connectionScope.defer(() => {
        connection.source?.disconnect();
        gain.disconnect();
        panner.disconnect();
        sink.srcObject = null;
      });
      connectionScope.adopt(pc, (closing) => {
        closing.close();
      });
      peer.connection = connection;

      let cancelDeadline: (() => void) | null = null;
      const startDeadline = (): void => {
        cancelDeadline ??= later(
          connectionScope,
          config.connectDeadlineMs,
          () => {
            fail(peerId, peer);
          },
        );
      };
      let restarted = false;
      startDeadline();

      pc.addEventListener(
        "track",
        (event) => {
          play(connection, event);
        },
        { signal },
      );
      pc.addEventListener(
        "icecandidate",
        ({ candidate }) => {
          if (candidate === null) return;
          send(peerId, connection, {
            candidate: {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
            },
          });
        },
        { signal },
      );
      pc.addEventListener(
        "negotiationneeded",
        () => {
          connection.makingOffer = true;
          pc.setLocalDescription()
            .then(() => {
              if (pc.localDescription !== null) {
                send(peerId, connection, {
                  description: pc.localDescription.toJSON(),
                });
              }
            })
            .catch((error: unknown) => {
              console.warn("Voice offer failed", error);
            })
            .finally(() => {
              connection.makingOffer = false;
            });
        },
        { signal },
      );
      pc.addEventListener(
        "connectionstatechange",
        () => {
          observe(connection);
          switch (pc.connectionState) {
            case "connected":
              cancelDeadline?.();
              cancelDeadline = null;
              peer.backoffMs = null;
              peer.failures = 0;
              break;
            case "disconnected":
              startDeadline();
              break;
            case "failed":
              startDeadline();
              // A connection never negotiated has nothing to restart.
              if (!restarted && pc.remoteDescription !== null) {
                restarted = true;
                pc.restartIce();
              }
              break;
            case "new":
            case "connecting":
            case "closed":
              break;
          }
        },
        { signal },
      );

      // The impolite side opens the audio line, and the polite side says it is ready for
      // it. A connection made to take up an offer answers on the line the offer brings. The
      // line carries both directions, so the mic can be swapped in without renegotiating.
      if (opener !== "offer" && !connection.polite) {
        pc.addTransceiver("audio", { direction: "sendrecv" });
        attachMic(pc);
      } else if (opener === "self") {
        send(peerId, connection, { ready: true });
      }
      return connection;
    }

    async function negotiate(
      connection: Connection,
      message: SignalMessage,
    ): Promise<void> {
      const { pc } = connection;
      if ("ready" in message) {
        // The other side may have dropped our offer while it was not connecting to us, so it
        // goes again, carrying the candidates gathered since.
        const unanswered =
          pc.signalingState === "have-local-offer" && !connection.makingOffer;
        if (unanswered && pc.localDescription !== null) {
          send(message.from, connection, {
            description: pc.localDescription.toJSON(),
          });
        }
        return;
      }
      if ("candidate" in message) {
        try {
          await pc.addIceCandidate(message.candidate);
        } catch (error) {
          if (!connection.ignoreOffer) throw error;
        }
        return;
      }

      const { description } = message;
      const current = pc.remoteDescription;
      if (current !== null && sameDescription(current.sdp, description.sdp))
        return;
      const collision =
        description.type === "offer" &&
        (connection.makingOffer || pc.signalingState !== "stable");
      connection.ignoreOffer = !connection.polite && collision;
      if (connection.ignoreOffer) return;

      await pc.setRemoteDescription(description);
      if (description.type !== "offer") return;
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.direction === "recvonly") {
          transceiver.direction = "sendrecv";
        }
      }
      attachMic(pc);
      await pc.setLocalDescription();
      if (pc.localDescription !== null) {
        send(message.from, connection, {
          description: pc.localDescription.toJSON(),
        });
      }
    }

    function opener(message: SignalMessage): Opener {
      return "ready" in message ? "ready" : "offer";
    }

    /** Hands a message from a wanted peer to the connection it belongs to. */
    function deliver(peerId: string, peer: Peer, message: SignalMessage): void {
      let connection = peer.connection;
      if (connection === null) {
        if (!opensNegotiation(message)) return;
        connection = connect(
          peerId,
          peer,
          opener(message),
          message.conn ?? null,
        );
      } else {
        const decision = connDecision(connection.remoteConn, message);
        if (decision.kind === "drop") return;
        if (decision.kind === "replace") {
          drop(peer);
          connection = connect(
            peerId,
            peer,
            opener(message),
            decision.remoteConn,
          );
        } else {
          connection.remoteConn = decision.remoteConn;
        }
      }
      negotiate(connection, message).catch((error: unknown) => {
        console.warn("Voice negotiation failed", error);
      });
    }

    function addPeer(peerId: string): void {
      const peer: Peer = {
        scope: scope.child(),
        connection: null,
        backoffMs: null,
        failures: 0,
        idleSince: performance.now(),
      };
      own.set(peerId, peer);
      for (const message of pending.take(peerId, performance.now())) {
        deliver(peerId, peer, message);
      }
      if (peer.connection === null) connect(peerId, peer, "self", null);
    }

    /** Hangs up on `peerId`, keeping its mix when it is to be connected again. */
    function removePeer(peerId: string, keepMix: boolean): void {
      const peer = own.get(peerId);
      own.delete(peerId);
      if (!keepMix) levels.forget(peerId);
      if (peer !== undefined) disposeQuietly(peer.scope);
    }

    /** Connects to the peers in `desired` and hangs up on the rest, redoing those in `redo`. */
    function reconcile(
      desired: ReadonlySet<string>,
      redo: ReadonlySet<string>,
    ): void {
      const { added, removed } = diffPeers(own.keys(), desired, redo);
      for (const id of removed) removePeer(id, desired.has(id));
      added.forEach(addPeer);
    }

    const voiceRoom: JoinedRoom = {
      receive(payload) {
        if (scope.disposed) return;
        const message = signalFor(payload, localId);
        if (message === null) return;
        const peer = own.get(message.from);
        if (peer === undefined) pending.hold(message, performance.now());
        else deliver(message.from, peer, message);
      },

      setPeers(ids) {
        if (scope.disposed) return;
        reconcile(ids, new Set());
      },

      retry(peerId) {
        if (scope.disposed) return;
        reconcile(new Set(own.keys()), new Set([peerId]));
      },

      setPeerMix(peerId, mix) {
        if (scope.disposed) return;
        levels.setMix(peerId, mix);
        applyLevels(peerId);
      },

      leave() {
        if (scope.disposed) return;
        own.clear();
        levels.forgetMixes();
        if (room === voiceRoom) room = null;
        disposeQuietly(scope);
      },
    };
    return voiceRoom;
  }

  return {
    requestMic() {
      mic.request();
    },

    join(localId, send, events) {
      room?.leave();
      mic.request();
      room = join(localId, send, events);
      return room;
    },

    configure(settings) {
      ({ mode, muted } = settings);
      volume = Math.max(0, Math.min(1, settings.volume));
      if (voiceVolume !== null) voiceVolume.gain.value = volume;
      mic.setDevice(settings.inputDevice);
      applyTransmit();
    },

    setMicTest(on) {
      testing = on;
      if (on) mic.request();
      applyTransmit();
    },

    retry(peerId) {
      room?.retry(peerId);
    },

    diagnostics() {
      const now = performance.now();
      const diagnosed: PeerDiagnostics[] = [];
      peers.forEach((peer, id) => {
        diagnosed.push(diagnose(id, peer, now));
      });
      return { mic: { ...mic.report(), testing }, peers: diagnosed };
    },

    setTalking(held) {
      talking = held;
      applyTransmit();
    },

    setPeerMuted(peerId, mute) {
      levels.setMuted(peerId, mute);
      applyLevels(peerId);
    },

    status() {
      const connected: string[] = [];
      const all: ReturnType<Voice["status"]>["connections"] = [];
      peers.forEach((peer, id) => {
        const { connection } = peer;
        if (connection === null) {
          all.push({ id, state: "pending", gain: 0 });
          return;
        }
        const state = connection.pc.connectionState;
        if (state === "connected") connected.push(id);
        all.push({ id, state, gain: connection.gain.gain.value });
      });
      return {
        mode,
        muted,
        mic: mic.state(),
        transmitting: transmitting(),
        peers: connected,
        mutedPeers: levels.mutedPeers(),
        connections: all,
      };
    },
  };
}
