import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  VoiceConnectionConfig,
  VoiceSettings,
} from "../../voice/index.js";
import { createWebRtcVoice } from "./webrtc-voice.js";

const ME = "player-b";
/** Sorts before ME, so ME is the impolite side and opens the audio line. */
const PEER = "player-a";

const CONFIG: VoiceConnectionConfig = {
  levelRampS: 0.05,
  connectDeadlineMs: 1000,
  pending: { cap: 8, ttlMs: 1000 },
  retry: { firstMs: 500, maxMs: 4000 },
  statsIntervalMs: 0,
};

const OPEN_MIC: VoiceSettings = {
  mode: "open",
  muted: false,
  volume: 1,
  inputDevice: null,
};

class FakeTrack extends EventTarget {
  enabled = true;
  stopped = false;
  constructor(readonly deviceId: string) {
    super();
  }
  stop(): void {
    this.stopped = true;
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeSender {
  readonly replaceTrack = vi.fn((track: FakeTrack | null) => {
    this.track = track;
    return Promise.resolve();
  });
  track: FakeTrack | null = null;
}

class FakePeerConnection extends EventTarget {
  static made: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription = null;
  remoteDescription = null;
  closed = false;
  stats = new Map<string, unknown>();
  readonly transceivers: { direction: string; sender: FakeSender }[] = [];

  constructor() {
    super();
    FakePeerConnection.made.push(this);
  }
  addTransceiver() {
    const transceiver = { direction: "sendrecv", sender: new FakeSender() };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  getTransceivers() {
    return this.transceivers;
  }
  getStats() {
    return Promise.resolve(new Map(this.stats));
  }
  setLocalDescription() {
    return Promise.resolve();
  }
  restartIce(): void {
    return undefined;
  }
  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }
  /** Moves to `state` the way a browser does, with an event. */
  become(state: RTCPeerConnectionState, ice: RTCIceConnectionState): void {
    this.connectionState = state;
    this.iceConnectionState = ice;
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  sender(): FakeSender {
    const [transceiver] = this.transceivers;
    if (transceiver === undefined) throw new Error("No audio line");
    return transceiver.sender;
  }
}

function fakeNode() {
  const param = () => ({ value: 0, setTargetAtTime: vi.fn() });
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: param(),
    pan: param(),
    context: { currentTime: 0 },
  };
}

/** Plays a steady half-scale tone into every meter. */
class FakeAudioContext {
  currentTime = 0;
  createGain = fakeNode;
  createStereoPanner = fakeNode;
  createMediaStreamSource = fakeNode;
  createAnalyser() {
    return {
      ...fakeNode(),
      fftSize: 8,
      getFloatTimeDomainData(samples: Float32Array) {
        samples.fill(0.5);
      },
    };
  }
  resume() {
    return Promise.resolve();
  }
}

class FakeAudio {
  muted = false;
  srcObject: unknown = null;
  play() {
    return Promise.resolve();
  }
}

/** Each capture hands out a new track, on the device asked for or "default"; "gone" is missing. */
const getUserMedia = vi.fn(
  (constraints: { audio: { deviceId?: { exact: string } } }) => {
    const deviceId = constraints.audio.deviceId?.exact ?? "default";
    if (deviceId === "gone") {
      return Promise.reject(
        new DOMException("No such device", "OverconstrainedError"),
      );
    }
    return Promise.resolve(new FakeMediaStream([new FakeTrack(deviceId)]));
  },
);

const DEVICES = [
  { kind: "audioinput", deviceId: "default", label: "Default" },
  { kind: "audioinput", deviceId: "usb", label: "USB mic" },
  { kind: "audiooutput", deviceId: "speakers", label: "Speakers" },
];

beforeEach(() => {
  FakePeerConnection.made = [];
  getUserMedia.mockClear();
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: () => Promise.resolve(DEVICES),
      addEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function voiceIn(settings: VoiceSettings = OPEN_MIC) {
  const context = new AudioContext();
  const output = context.createGain();
  const voice = createWebRtcVoice(
    { audioContext: () => context, output: () => output },
    settings,
    CONFIG,
  );
  const failed: string[] = [];
  const room = voice.join(ME, () => undefined, {
    peerFailed: (id) => failed.push(id),
  });
  room.setPeers(new Set([PEER]));
  return { voice, room, failed };
}

function lastConnection(): FakePeerConnection {
  const pc = FakePeerConnection.made.at(-1);
  if (pc === undefined) throw new Error("No connection");
  return pc;
}

describe("the local mic", () => {
  test("switching device captures the new one and replaces the track on each connection", async () => {
    const { voice } = voiceIn();
    await settle();
    const sender = lastConnection().sender();
    const first = sender.track;
    expect(first?.deviceId).toBe("default");

    voice.configure({ ...OPEN_MIC, inputDevice: "usb" });
    await settle();

    expect(getUserMedia.mock.lastCall?.[0].audio.deviceId).toEqual({
      exact: "usb",
    });
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: "usb" }),
    );
    expect(first?.stopped).toBe(true);
    expect(voice.diagnostics().mic.device).toBe("usb");
  });

  test("a saved device that is gone falls back to the default", async () => {
    const { voice } = voiceIn({ ...OPEN_MIC, inputDevice: "gone" });
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(voice.diagnostics().mic).toMatchObject({
      state: "live",
      device: "default",
    });
  });

  test("lists the audio inputs, without the browser's default alias", async () => {
    const { voice } = voiceIn();
    await settle();
    expect(voice.diagnostics().mic.devices).toEqual([
      { id: "usb", label: "USB mic" },
    ]);
  });

  test("a mic test meters the mic without sending it", async () => {
    const { voice } = voiceIn({ ...OPEN_MIC, mode: "pushToTalk" });
    await settle();
    const sender = lastConnection().sender();
    expect(voice.diagnostics().mic.level).toBe(0);

    voice.setMicTest(true);
    const testing = voice.diagnostics().mic;
    expect(testing.testing).toBe(true);
    expect(testing.level).toBeGreaterThan(0);
    expect(sender.track).toBeNull();
    expect(voice.status().transmitting).toBe(false);

    voice.setMicTest(false);
    expect(voice.diagnostics().mic.level).toBe(0);
  });

  test("speaks at the mic's level only while it goes out", async () => {
    const { voice } = voiceIn({ ...OPEN_MIC, mode: "pushToTalk" });
    expect(voice.speakingLevel()).toBe(0);
    await settle();
    voice.setMicTest(true);
    expect(voice.speakingLevel()).toBe(0);

    voice.setTalking(true);
    expect(voice.speakingLevel()).toBeGreaterThan(0);
    voice.setTalking(false);
    expect(voice.speakingLevel()).toBe(0);

    voice.configure(OPEN_MIC);
    expect(voice.speakingLevel()).toBeGreaterThan(0);
    voice.configure({ ...OPEN_MIC, muted: true });
    expect(voice.speakingLevel()).toBe(0);
  });

  test("a refused mic reports denied until asking again succeeds", async () => {
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    const { voice } = voiceIn();
    await settle();
    expect(voice.diagnostics().mic).toMatchObject({
      permission: "denied",
      state: "denied",
    });

    voice.requestMic();
    await settle();
    expect(voice.diagnostics().mic).toMatchObject({
      permission: "granted",
      state: "live",
    });
    expect(lastConnection().sender().track).not.toBeNull();
  });

  test("asking for a mic already captured does not capture it again", async () => {
    const { voice } = voiceIn();
    await settle();
    voice.requestMic();
    await settle();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});

describe("connection diagnostics", () => {
  test("report each peer's states, route, and whether audio is arriving", async () => {
    const { voice } = voiceIn();
    await settle();
    const pc = lastConnection();
    pc.become("connected", "connected");
    pc.stats = new Map<string, unknown>([
      ["T", { type: "transport", selectedCandidatePairId: "P" }],
      [
        "P",
        {
          type: "candidate-pair",
          localCandidateId: "L",
          remoteCandidateId: "R",
        },
      ],
      ["L", { type: "local-candidate", candidateType: "srflx" }],
      ["R", { type: "remote-candidate", candidateType: "host" }],
      ["I", { type: "inbound-rtp", kind: "audio", bytesReceived: 100 }],
    ]);

    voice.diagnostics();
    await settle();
    expect(voice.diagnostics().peers).toMatchObject([
      {
        id: PEER,
        state: "connected",
        ice: "connected",
        signaling: "stable",
        route: { local: "srflx", remote: "host" },
        bytesReceived: 100,
        receiving: true,
        failures: 0,
      },
    ]);

    await settle();
    expect(voice.diagnostics().peers[0]?.receiving).toBe(false);
  });

  test("a connection closed without an event shows as closed", async () => {
    const { voice } = voiceIn();
    await settle();
    lastConnection().close();
    expect(voice.diagnostics().peers[0]?.state).toBe("closed");
  });

  test("a connection past its deadline counts as a failure until one connects", () => {
    vi.useFakeTimers();
    const { voice, failed } = voiceIn();
    vi.advanceTimersByTime(CONFIG.connectDeadlineMs);
    expect(failed).toEqual([PEER]);
    expect(voice.diagnostics().peers[0]).toMatchObject({
      state: "pending",
      failures: 1,
    });

    vi.advanceTimersByTime(CONFIG.retry.firstMs);
    lastConnection().become("connected", "connected");
    expect(voice.diagnostics().peers[0]).toMatchObject({
      state: "connected",
      failures: 0,
    });
  });
});

describe("retry", () => {
  test("hangs up on the peer and connects to it afresh", async () => {
    const { voice } = voiceIn();
    await settle();
    const before = lastConnection();

    voice.retry(PEER);
    await settle();

    expect(before.closed).toBe(true);
    const after = lastConnection();
    expect(after).not.toBe(before);
    expect(after.closed).toBe(false);
    expect(after.sender().track).not.toBeNull();
    expect(voice.diagnostics().peers.map(({ id }) => id)).toEqual([PEER]);
  });

  test("does nothing for a player voice is not connecting to", async () => {
    const { voice } = voiceIn();
    await settle();
    voice.retry("player-z");
    expect(FakePeerConnection.made).toHaveLength(1);
    expect(voice.diagnostics().peers.map(({ id }) => id)).toEqual([PEER]);
  });
});
