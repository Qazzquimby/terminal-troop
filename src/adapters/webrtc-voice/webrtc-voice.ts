import type { SignalMessage } from "./signal.js";
import { isPolite, signalFor } from "./signal.js";
import type { NetEvent, Transport } from "../../net/index.js";
import type { MicState, Voice, VoiceSettings } from "../../voice/index.js";
import { createPeerLevels } from "./peer-levels.js";
import { isTransmitting } from "./transmit.js";

/** Where voice plays: the shared AudioContext, and the node incoming voice connects to. */
interface VoiceAudio {
  audioContext: () => AudioContext;
  output: () => AudioNode;
}

/** Time constant, in seconds, of the ramp a peer's gain and pan follow to a new level. */
const LEVEL_RAMP_S = 0.05;

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

interface Peer {
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

type Signal =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit };

/**
 * Voice over WebRTC: a mesh with one RTCPeerConnection per remote player, set up through
 * `signalEvent` messages on the room transport using the "perfect negotiation" pattern.
 *
 * Playback: remote stream -> source -> per-peer gain -> panner -> voice volume -> `output`.
 * The per-peer gain is the mix volume, or 0 while that player is muted.
 */
export function createWebRtcVoice(
  audio: VoiceAudio,
  initial: VoiceSettings,
  signalEvent: NetEvent,
): Voice {
  const { audioContext } = audio;
  const peers = new Map<string, Peer>();
  const levels = createPeerLevels();
  let room: {
    localId: string;
    transport: Pick<Transport, "send">;
  } | null = null;
  let mic: MicState = "pending";
  let micTrack: MediaStreamTrack | null = null;
  let micRequested = false;
  let talking = false;
  let { mode, muted, volume } = initial;
  let voiceVolume: GainNode | null = null;

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

  function applyTransmit(): void {
    if (micTrack !== null) micTrack.enabled = transmitting();
    peers.forEach((peer) => {
      attachMic(peer.pc);
    });
  }

  /** Sets a peer's playback nodes from its levels; does nothing for a peer without nodes. */
  function applyLevels(peerId: string): void {
    const peer = peers.get(peerId);
    if (peer === undefined) return;
    const { gain, pan } = levels.levels(peerId);
    const now = peer.gain.context.currentTime;
    peer.gain.gain.setTargetAtTime(gain, now, LEVEL_RAMP_S);
    peer.panner.pan.setTargetAtTime(pan, now, LEVEL_RAMP_S);
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

  function send(to: string, signal: Signal): void {
    if (room === null) return;
    void room.transport.send(signalEvent, {
      from: room.localId,
      to,
      ...signal,
    });
  }

  function play(peer: Peer, event: RTCTrackEvent): void {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    peer.sink.srcObject = stream;
    void peer.sink.play().catch(() => undefined);
    peer.source?.disconnect();
    peer.source = audioContext().createMediaStreamSource(stream);
    peer.source.connect(peer.gain);
  }

  function connect(localId: string, peerId: string): Peer {
    const context = audioContext();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const gain = context.createGain();
    const panner = context.createStereoPanner();
    gain.connect(panner);
    panner.connect(volumeGain());
    const sink = new Audio();
    sink.muted = true;

    const peer: Peer = {
      pc,
      polite: isPolite(localId, peerId),
      gain,
      panner,
      sink,
      source: null,
      makingOffer: false,
      ignoreOffer: false,
    };
    peers.set(peerId, peer);
    applyLevels(peerId);

    pc.ontrack = (event) => {
      play(peer, event);
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate === null) return;
      send(peerId, {
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        },
      });
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription !== null) {
          send(peerId, { description: pc.localDescription.toJSON() });
        }
      } catch (error) {
        console.warn("Voice offer failed", error);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") pc.restartIce();
    };

    // One side opens the audio line; the other answers on it. Either way the line carries
    // both directions, so the mic can be swapped in later without renegotiating.
    if (!peer.polite) {
      pc.addTransceiver("audio", { direction: "sendrecv" });
      attachMic(pc);
    }
    return peer;
  }

  async function negotiate(peer: Peer, message: SignalMessage): Promise<void> {
    const { pc } = peer;
    if ("candidate" in message) {
      try {
        await pc.addIceCandidate(message.candidate);
      } catch (error) {
        if (!peer.ignoreOffer) throw error;
      }
      return;
    }

    const { description } = message;
    const collision =
      description.type === "offer" &&
      (peer.makingOffer || pc.signalingState !== "stable");
    peer.ignoreOffer = !peer.polite && collision;
    if (peer.ignoreOffer) return;

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
      send(message.from, { description: pc.localDescription.toJSON() });
    }
  }

  function removePeer(peerId: string): void {
    levels.forget(peerId);
    const peer = peers.get(peerId);
    if (peer === undefined) return;
    peers.delete(peerId);
    peer.pc.close();
    peer.source?.disconnect();
    peer.gain.disconnect();
    peer.panner.disconnect();
    peer.sink.srcObject = null;
  }

  function leave(): void {
    for (const peerId of [...peers.keys()]) removePeer(peerId);
    room = null;
  }

  return {
    requestMic,

    join(localId, transport) {
      leave();
      room = { localId, transport };
      requestMic();
    },

    leave,

    receive(payload) {
      if (room === null) return;
      const message = signalFor(payload, room.localId);
      if (message === null) return;
      let peer = peers.get(message.from);
      if (peer === undefined) {
        // An offer can beat the STATE that would have introduced its sender.
        if (!("description" in message) || message.description.type !== "offer")
          return;
        peer = connect(room.localId, message.from);
      }
      negotiate(peer, message).catch((error: unknown) => {
        console.warn("Voice negotiation failed", error);
      });
    },

    addPeer(peerId) {
      if (room === null || peers.has(peerId)) return;
      connect(room.localId, peerId);
    },

    removePeer,

    setMode(next) {
      mode = next;
      applyTransmit();
    },

    setTalking(held) {
      talking = held;
      applyTransmit();
    },

    setMuted(next) {
      muted = next;
      applyTransmit();
    },

    setVolume(next) {
      volume = Math.max(0, Math.min(1, next));
      if (voiceVolume !== null) voiceVolume.gain.value = volume;
    },

    setPeerMix(peerId, mix) {
      levels.setMix(peerId, mix);
      applyLevels(peerId);
    },

    setPeerMuted(peerId, mute) {
      levels.setMuted(peerId, mute);
      applyLevels(peerId);
    },

    status() {
      const connected: string[] = [];
      peers.forEach((peer, peerId) => {
        if (peer.pc.connectionState === "connected") connected.push(peerId);
      });
      return {
        mode,
        mic,
        transmitting: transmitting(),
        peers: connected,
        mutedPeers: levels.mutedPeers(),
      };
    },
  };
}
