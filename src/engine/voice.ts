import type { Settings } from "./settings.js";
import type { Transport } from "./transport.js";

/** The player's own voice preferences: transmit mode, mic mute, and incoming volume. */
export type VoiceSettings = Settings["voice"];

/** Open mic transmits whenever unmuted; push-to-talk only while the talk action is held. */
export type VoiceMode = VoiceSettings["mode"];

/**
 * - pending: not asked yet, or waiting on the browser's permission prompt
 * - live: the mic is captured (it may still be muted or waiting for push-to-talk)
 * - denied: the player refused; voice stays listen-only
 * - unavailable: no mic, or no voice support in this browser
 */
export type MicState = "pending" | "live" | "denied" | "unavailable";

/** How loud and where (-1 left .. 1 right) one remote player is heard. */
export interface PeerMix {
  volume: number;
  pan: number;
}

const DEFAULT_PEER_MIX: PeerMix = { volume: 1, pan: 0 };

/** The gain one remote player is played at: silent while muted, otherwise the mix volume. */
export function peerGain(mix: PeerMix, muted: boolean): number {
  return muted ? 0 : mix.volume;
}

/**
 * Per-peer mix and mute, kept apart so the mix can be rewritten every frame without
 * clobbering a mute. Mutes are remembered by peer id for the whole session: they apply
 * before a peer connects and survive the peer leaving and rejoining.
 */
export function createPeerLevels() {
  const mixes = new Map<string, PeerMix>();
  const muted = new Set<string>();
  return {
    setMix(peerId: string, mix: PeerMix): void {
      mixes.set(peerId, mix);
    },
    setMuted(peerId: string, mute: boolean): void {
      if (mute) muted.add(peerId);
      else muted.delete(peerId);
    },
    /** A peer left: drop its mix, but keep its mute. */
    forget(peerId: string): void {
      mixes.delete(peerId);
    },
    /** Gain and pan to apply to this peer's playback nodes now. */
    levels(peerId: string): { gain: number; pan: number } {
      const mix = mixes.get(peerId) ?? DEFAULT_PEER_MIX;
      return { gain: peerGain(mix, muted.has(peerId)), pan: mix.pan };
    },
    mutedPeers: (): string[] => [...muted],
  };
}

interface VoiceStatus {
  mode: VoiceMode;
  mic: MicState;
  /** Whether our mic is currently going out to the other players. */
  transmitting: boolean;
  /** Remote players with an established voice connection. */
  peers: string[];
  /** Remote players we muted locally, connected or not. */
  mutedPeers: string[];
}

/**
 * Port for voice chat between the players of a room. The adapter owns the media and the
 * connections; game code only reports who is in the room and turns knobs.
 */
export interface Voice {
  /** Asks for the mic. Call from a user gesture (a click), since browsers require one. */
  requestMic: () => void;
  /** Starts voice in a room. Setup messages go out through `transport` as SIGNAL events. */
  join: (localId: string, transport: Pick<Transport, "send">) => void;
  /** Hangs up on everyone. The mic stays captured for the next room. */
  leave: () => void;
  /** Feeds in a SIGNAL payload received from the room, unparsed. */
  receive: (payload: unknown) => void;
  /** A remote player is in the room: connect to them. */
  addPeer: (peerId: string) => void;
  /** A remote player left: hang up on them. */
  removePeer: (peerId: string) => void;
  setMode: (mode: VoiceMode) => void;
  /** Whether push-to-talk is held. Ignored in open-mic mode. */
  setTalking: (held: boolean) => void;
  /** Hard mute of the outgoing mic, in either mode. */
  setMuted: (muted: boolean) => void;
  /** Volume for every incoming voice, 0..1. */
  setVolume: (volume: number) => void;
  /** Volume and pan for one remote player; defaults to DEFAULT_PEER_MIX. */
  setPeerMix: (peerId: string, mix: PeerMix) => void;
  /**
   * Local mute of one remote player's voice, on top of their mix: later setPeerMix calls
   * keep it. Remembered by peer id for the session, so it outlasts a reconnect.
   */
  setPeerMuted: (peerId: string, muted: boolean) => void;
  status: () => VoiceStatus;
}

/** Sets every voice preference in `settings` on `voice`. */
export function applyVoiceSettings(
  voice: Pick<Voice, "setMode" | "setMuted" | "setVolume">,
  settings: VoiceSettings,
): void {
  voice.setMode(settings.mode);
  voice.setMuted(settings.muted);
  voice.setVolume(settings.volume);
}

export function isTransmitting(
  mode: VoiceMode,
  talking: boolean,
  muted: boolean,
): boolean {
  if (muted) return false;
  return mode === "open" || talking;
}

/**
 * Which side of a pair yields when both start negotiating at once. Both players compute it
 * from the two ids, so exactly one of them is polite.
 */
export function isPolite(localId: string, remoteId: string): boolean {
  return localId < remoteId;
}

/** Voice that does nothing: for tests, and browsers without WebRTC. */
export function createNullVoice(initial: VoiceSettings): Voice {
  let { mode } = initial;
  const noop = (): void => undefined;
  return {
    requestMic: noop,
    join: noop,
    leave: noop,
    receive: noop,
    addPeer: noop,
    removePeer: noop,
    setMode(next) {
      mode = next;
    },
    setTalking: noop,
    setMuted: noop,
    setVolume: noop,
    setPeerMix: noop,
    setPeerMuted: noop,
    status: () => ({
      mode,
      mic: "unavailable",
      transmitting: false,
      peers: [],
      mutedPeers: [],
    }),
  };
}
