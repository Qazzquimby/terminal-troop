import type { SignalMessage } from "./signal.js";
import {
  isPolite,
  opensNegotiation,
  sameDescription,
  signalFor,
} from "./signal.js";
import type {
  MicState,
  Voice,
  VoiceConnectionConfig,
  VoiceRoom,
  VoiceSettings,
} from "../../voice/index.js";
import type { Scope } from "../../scope/index.js";
import { createPeerLevels } from "./peer-levels.js";
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

interface VoiceDeps {
  audio: VoiceAudio;
  /** Makes the scope each room, peer and connection is cleaned up through. */
  createScope: () => Scope;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
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
}

/** A peer voice wants a connection with; between attempts it has none. */
interface Peer {
  readonly scope: Scope;
  connection: Connection | null;
  /** The wait before the latest retry, or null since the last success. */
  backoffMs: number | null;
}

/** Why a connection opens: on our own, or to take up an offer or a ready from the peer. */
type Opener = "self" | "offer" | "ready";

type Signal =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit }
  | { ready: true };

/** Runs `fn` after `ms` unless `scope` is disposed first. */
function later(scope: Scope, ms: number, fn: () => void): () => void {
  const stop = (): void => {
    clearTimeout(timer);
    scope.signal.removeEventListener("abort", stop);
  };
  const timer = setTimeout(() => {
    stop();
    fn();
  }, ms);
  scope.signal.addEventListener("abort", stop);
  return stop;
}

function disposeQuietly(scope: Scope): void {
  scope.dispose().catch((error: unknown) => {
    console.warn("Voice cleanup failed", error);
  });
}

/**
 * Voice over WebRTC: a mesh with one RTCPeerConnection per wanted remote player, set up
 * through SIGNAL messages using the "perfect negotiation" pattern.
 *
 * Playback: remote stream -> source -> per-peer gain -> panner -> voice volume -> `output`.
 * The per-peer gain is the mix volume, or 0 while that player is muted.
 */
export function createWebRtcVoice(
  { audio, createScope }: VoiceDeps,
  initial: VoiceSettings,
  config: VoiceConnectionConfig,
): Voice {
  const { audioContext } = audio;
  const levels = createPeerLevels();
  /** The peers of the room joined now, by id. */
  let peers = new Map<string, Peer>();
  let mic: MicState = "pending";
  let micTrack: MediaStreamTrack | null = null;
  let micRequested = false;
  let talking = false;
  let { mode, muted, volume } = initial;
  let voiceVolume: GainNode | null = null;
  let room: VoiceRoom | null = null;

  function volumeGain(): GainNode {
    if (voiceVolume === null) {
      voiceVolume = audioContext().createGain();
      voiceVolume.gain.value = volume;
      voiceVolume.connect(audio.output());
    }
    return voiceVolume;
  }

  function transmitting(): boolean {
    return micTrack !== null && isTransmitting(mode, talking, muted);
  }

  /**
   * Puts the mic on, or takes it off, every audio line allowed to send. A disabled track
   * still sends comfort-noise packets, so silence also detaches it: nothing goes out.
   */
  function attachMic(pc: RTCPeerConnection): void {
    const track = transmitting() ? micTrack : null;
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

  function applyTransmit(): void {
    if (micTrack !== null) micTrack.enabled = transmitting();
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

  function requestMic(): void {
    if (micRequested) return;
    micRequested = true;
    void audioContext().resume();
    // Absent outside secure contexts (plain http on a LAN address).
    if (!("mediaDevices" in navigator)) {
      mic = "unavailable";
      return;
    }
    navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS).then(
      (stream) => {
        const [track] = stream.getAudioTracks();
        if (track === undefined) {
          mic = "unavailable";
          return;
        }
        micTrack = track;
        mic = "live";
        applyTransmit();
      },
      (error: unknown) => {
        const refused =
          error instanceof DOMException && error.name === "NotAllowedError";
        mic = refused ? "denied" : "unavailable";
      },
    );
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
  ): VoiceRoom {
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
      disposeQuietly(connection.scope);
    }

    /** Gives up on the peer's connection, and tries again after a growing wait. */
    function fail(peerId: string, peer: Peer): void {
      events.peerFailed(peerId);
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
          switch (pc.connectionState) {
            case "connected":
              cancelDeadline?.();
              cancelDeadline = null;
              peer.backoffMs = null;
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
      };
      own.set(peerId, peer);
      for (const message of pending.take(peerId, performance.now())) {
        deliver(peerId, peer, message);
      }
      if (peer.connection === null) connect(peerId, peer, "self", null);
    }

    function removePeer(peerId: string): void {
      const peer = own.get(peerId);
      own.delete(peerId);
      levels.forget(peerId);
      if (peer !== undefined) disposeQuietly(peer.scope);
    }

    const voiceRoom: VoiceRoom = {
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
        const { added, removed } = diffPeers(own.keys(), ids);
        removed.forEach(removePeer);
        added.forEach(addPeer);
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
    requestMic,

    join(localId, send, events) {
      room?.leave();
      requestMic();
      room = join(localId, send, events);
      return room;
    },

    configure(settings) {
      ({ mode, muted } = settings);
      volume = Math.max(0, Math.min(1, settings.volume));
      if (voiceVolume !== null) voiceVolume.gain.value = volume;
      applyTransmit();
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
        mic,
        transmitting: transmitting(),
        peers: connected,
        mutedPeers: levels.mutedPeers(),
        connections: all,
      };
    },
  };
}
