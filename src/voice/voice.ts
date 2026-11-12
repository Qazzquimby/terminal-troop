import type { UiHandlers } from "../input/index.js";
import type { Settings } from "../settings/index.js";

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

/**
 * Whether the browser lets this page use the microphone:
 * - granted: allowed
 * - denied: blocked, until the player allows it in the browser
 * - prompt: the browser will ask
 * - unavailable: this browser or page (not https) offers no microphone at all
 */
export type MicPermission = "granted" | "denied" | "prompt" | "unavailable";

/** An audio input the browser lists. Labels are empty until mic access is granted. */
export interface MicDevice {
  readonly id: string;
  readonly label: string;
}

interface MicDiagnostics {
  readonly permission: MicPermission;
  readonly state: MicState;
  readonly devices: readonly MicDevice[];
  /** The device being captured, or null while there is none. */
  readonly device: string | null;
  /** Input loudness, 0..1, while the mic is testing or transmitting; 0 otherwise. */
  readonly level: number;
  /** Whether the mic is captured for testing, without being sent to anyone. */
  readonly testing: boolean;
}

/** How a connection reaches its peer: directly (host), through a NAT (srflx, prflx), or a relay. */
export type CandidateType = "host" | "srflx" | "prflx" | "relay";

/** One wanted peer of the current room, as its connection last reported. */
export interface PeerDiagnostics {
  readonly id: string;
  readonly state: RTCPeerConnectionState | "pending";
  readonly ice: RTCIceConnectionState | null;
  readonly signaling: RTCSignalingState | null;
  /** When `state` last changed, on the `performance.now()` clock. */
  readonly since: number;
  /** Candidate types of the pair in use, ours and theirs; null until one is picked. */
  readonly route: {
    readonly local: CandidateType;
    readonly remote: CandidateType;
  } | null;
  readonly bytesReceived: number;
  /** Whether audio bytes arrived between the last two reads of the connection. */
  readonly receiving: boolean;
  /** Connection attempts that failed since this peer last connected. */
  readonly failures: number;
}

/** A read-only look at the mic and the connections, for players working out what is wrong. */
export interface VoiceDiagnostics {
  readonly mic: MicDiagnostics;
  readonly peers: readonly PeerDiagnostics[];
}

/** How loud and where (-1 left .. 1 right) one remote player is heard. */
export interface PeerMix {
  volume: number;
  pan: number;
}

/** Timings and limits a voice implementation holds its connections to. */
export interface VoiceConnectionConfig {
  /** Time constant, in seconds, of the ramp a peer's gain and pan follow to a new level. */
  levelRampS: number;
  /** How long a connection may stay down, from its start or from dropping, before it fails. */
  connectDeadlineMs: number;
  /** Signals held from players not wanted yet: at most `cap` per player, for `ttlMs`. */
  pending: { cap: number; ttlMs: number };
  /** Waits between attempts to reconnect a peer whose connection failed. */
  retry: { firstMs: number; maxMs: number };
  /** Least time between connection statistics reads, per connection. */
  statsIntervalMs: number;
}

/** One wanted peer. Its state is "pending" while it waits for its next connection attempt. */
interface VoiceConnection {
  id: string;
  state: RTCPeerConnectionState | "pending";
  /** The gain this peer's voice plays at right now. */
  gain: number;
}

interface VoiceStatus {
  mode: VoiceMode;
  /** Hard mute of the outgoing mic, in either mode. */
  muted: boolean;
  mic: MicState;
  /** Whether our mic is currently going out to the other players. */
  transmitting: boolean;
  /** Remote players with an established voice connection. */
  peers: string[];
  /** Remote players we muted locally, connected or not. */
  mutedPeers: string[];
  /** Every peer the current room holds a connection for, in any state. */
  connections: VoiceConnection[];
}

/** Hears about voice connections that do not come up. */
interface VoiceRoomEvents {
  /** The connection to `id` stayed down past its deadline. Voice retries while it is wanted. */
  peerFailed(id: string): void;
}

/** Voice in one room. Inert after `leave()`. */
export interface VoiceRoom {
  /** Feeds in a SIGNAL payload received from the room, unparsed. */
  receive(payload: unknown): void;
  /**
   * The remote players to hold voice connections with. Players added get a connection and
   * players dropped are hung up on. Signals from anyone else never open a connection.
   */
  setPeers(ids: ReadonlySet<string>): void;
  /** Volume and pan for one remote player, kept even before it connects; silent until set. */
  setPeerMix(id: string, mix: PeerMix): void;
  /** Hangs up on everyone in the room. */
  leave(): void;
}

/**
 * Port for voice chat between the players of a room. The adapter owns the media and the
 * connections; game code only says who to talk to and turns knobs.
 */
export interface Voice {
  /**
   * Asks for the mic, again if it was refused or missing before; does nothing while it is
   * captured or being asked for. Call from a user gesture (a click), since browsers require one.
   */
  requestMic(): void;
  /**
   * Applies the player's transmit mode, mic mute, incoming volume (0..1) and input device.
   * Once the mic is captured, a new device replaces it on every connection.
   */
  configure(settings: VoiceSettings): void;
  /** Whether push-to-talk is held. Ignored in open-mic mode. */
  setTalking(held: boolean): void;
  /**
   * Local mute of one remote player's voice, on top of their mix: later setPeerMix calls
   * keep it. Remembered by peer id across rooms, so it outlasts a reconnect.
   */
  setPeerMuted(id: string, muted: boolean): void;
  status(): VoiceStatus;
  /** Captures the mic for its level meter without sending it anywhere, or stops testing. */
  setMicTest(on: boolean): void;
  /** Hangs up on peer `id` of the current room and connects to it afresh. */
  retry(id: string): void;
  /** Cheap enough to call every frame; connection statistics refresh in the background. */
  diagnostics(): VoiceDiagnostics;
  /**
   * Starts voice in a room, leaving the room joined before. Setup messages go out through
   * `send`, for the room to deliver as SIGNAL events. The mic stays captured across rooms.
   */
  join(
    localId: string,
    send: (signal: unknown) => void,
    events: VoiceRoomEvents,
  ): VoiceRoom;
}

/** UI handlers that keep `voice` talking exactly while the action is held. */
export function pushToTalk(voice: Pick<Voice, "setTalking">): UiHandlers {
  return {
    held(held) {
      voice.setTalking(held);
    },
  };
}

/** Voice that does nothing: for tests, and browsers without WebRTC. */
export function createNullVoice(initial: VoiceSettings): Voice {
  let { mode, muted } = initial;
  const noop = (): void => undefined;
  const room: VoiceRoom = {
    receive: noop,
    setPeers: noop,
    setPeerMix: noop,
    leave: noop,
  };
  return {
    requestMic: noop,
    configure(settings) {
      ({ mode, muted } = settings);
    },
    setTalking: noop,
    setPeerMuted: noop,
    setMicTest: noop,
    retry: noop,
    diagnostics: () => ({
      mic: {
        permission: "unavailable",
        state: "unavailable",
        devices: [],
        device: null,
        level: 0,
        testing: false,
      },
      peers: [],
    }),
    status: () => ({
      mode,
      muted,
      mic: "unavailable",
      transmitting: false,
      peers: [],
      mutedPeers: [],
      connections: [],
    }),
    join: () => room,
  };
}
