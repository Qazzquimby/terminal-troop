import { describe, expect, test } from "vitest";
import type { Action, InputContext } from "../src/engine/actions.js";
import {
  ACTIONS,
  createActionState,
  withUiHandlers,
} from "../src/engine/actions.js";
import { createKeyboardSource } from "../src/engine/keyboard.js";
import { signalFor } from "../src/engine/protocol.js";
import { DEFAULT_SETTINGS } from "../src/engine/settings.js";
import type { Voice, VoiceMode, VoiceSettings } from "../src/engine/voice.js";
import {
  applyVoiceSettings,
  createNullVoice,
  createPeerLevels,
  isPolite,
  isTransmitting,
  peerGain,
} from "../src/engine/voice.js";

const ME = "player-b";
const OFFER = { type: "offer", sdp: "v=0\r\n" };
const CANDIDATE = {
  candidate: "candidate:1 1 udp 2122260223 192.0.2.1 54400 typ host",
  sdpMid: "0",
  sdpMLineIndex: 0,
};

describe("signal messages", () => {
  test("a description addressed to us parses", () => {
    const message = { from: "player-a", to: ME, description: OFFER };
    expect(signalFor(message, ME)).toEqual(message);
  });

  test("a candidate addressed to us parses, with null mid and index", () => {
    const candidate = { ...CANDIDATE, sdpMid: null, sdpMLineIndex: null };
    const message = { from: "player-a", to: ME, candidate };
    expect(signalFor(message, ME)).toEqual(message);
  });

  test("messages addressed to someone else are ignored", () => {
    expect(
      signalFor({ from: "player-a", to: "player-c", description: OFFER }, ME),
    ).toBeNull();
    expect(
      signalFor({ from: "player-a", to: "player-c", candidate: CANDIDATE }, ME),
    ).toBeNull();
  });

  test("messages from ourselves are ignored", () => {
    expect(signalFor({ from: ME, to: ME, description: OFFER }, ME)).toBeNull();
  });

  test.each([
    ["no payload", null],
    ["missing body", { from: "player-a", to: ME }],
    ["missing sender", { to: ME, description: OFFER }],
    [
      "unknown description type",
      { from: "player-a", to: ME, description: { type: "hack", sdp: "" } },
    ],
    [
      "description without sdp",
      { from: "player-a", to: ME, description: { type: "offer" } },
    ],
    [
      "candidate with a bad index",
      {
        from: "player-a",
        to: ME,
        candidate: { ...CANDIDATE, sdpMLineIndex: -1 },
      },
    ],
    ["empty sender id", { from: "", to: ME, description: OFFER }],
  ])("rejects %s", (_name, payload) => {
    expect(signalFor(payload, ME)).toBeNull();
  });
});

describe("negotiation roles", () => {
  test("exactly one side of a pair is polite", () => {
    const pairs = [
      ["a", "b"],
      ["0f3c", "0f3b"],
      ["4d6e1a2b-0000", "4d6e1a2b-0001"],
    ] as const;
    for (const [one, other] of pairs) {
      expect(isPolite(one, other)).not.toBe(isPolite(other, one));
    }
  });

  test("the lower id is polite", () => {
    expect(isPolite("a", "b")).toBe(true);
    expect(isPolite("b", "a")).toBe(false);
  });
});

describe("transmitting", () => {
  const cases: [VoiceMode, boolean, boolean, boolean][] = [
    // mode, talking, muted, transmitting
    ["open", false, false, true],
    ["open", true, false, true],
    ["open", false, true, false],
    ["open", true, true, false],
    ["pushToTalk", false, false, false],
    ["pushToTalk", true, false, true],
    ["pushToTalk", false, true, false],
    ["pushToTalk", true, true, false],
  ];
  test.each(cases)(
    "%s, talking %s, muted %s -> %s",
    (mode, talking, muted, expected) => {
      expect(isTransmitting(mode, talking, muted)).toBe(expected);
    },
  );
});

/**
 * Push-to-talk on the real action table, with UI handlers that record each talk change and
 * its time. `hold` and `letGo` drive the action through the keyboard source by name.
 */
function talkInput(context: InputContext) {
  const talk: [boolean, number][] = [];
  const state = createActionState();
  const keyboard = createKeyboardSource<Action, InputContext>(
    withUiHandlers(state, {
      pushToTalk: {
        press: (time) => talk.push([true, time]),
        release: (time) => talk.push([false, time]),
      },
    }),
    ACTIONS,
    context,
  );
  const [key] = ACTIONS.pushToTalk.keys;
  return {
    talk,
    state,
    keyboard,
    hold: (time: number) => keyboard.keyDown(key, false, time),
    letGo: (time: number) => keyboard.keyUp(key, time),
  };
}

describe("push-to-talk action", () => {
  test("the action state reports a press and a release", () => {
    const state = createActionState();
    state.press("pushToTalk", 1);
    expect(state.consume(1).pressed.has("pushToTalk")).toBe(true);
    state.release("pushToTalk", 2);
    const frame = state.consume(2);
    expect(frame.released.has("pushToTalk")).toBe(true);
    expect(frame.held.has("pushToTalk")).toBe(false);
  });

  test.each<InputContext>(["play", "menu"])(
    "talks while held in %s",
    (context) => {
      const input = talkInput(context);
      input.hold(1);
      input.letGo(2);
      expect(input.talk).toEqual([
        [true, 1],
        [false, 2],
      ]);
    },
  );

  test("does nothing while typing", () => {
    const input = talkInput("text");
    input.hold(1);
    input.letGo(2);
    expect(input.talk).toEqual([]);
  });

  test("switching into text releases it at the switch time", () => {
    const input = talkInput("play");
    input.hold(1);
    input.keyboard.setContext("text", 5);
    input.letGo(6);
    expect(input.talk).toEqual([
      [true, 1],
      [false, 5],
    ]);
    expect(input.state.consume(6).released.has("pushToTalk")).toBe(true);
  });

  test("blur releases it", () => {
    const input = talkInput("menu");
    input.hold(1);
    input.keyboard.blur(3);
    input.letGo(4);
    expect(input.talk).toEqual([
      [true, 1],
      [false, 3],
    ]);
  });
});

describe("settings", () => {
  test.each<VoiceSettings>([
    DEFAULT_SETTINGS.voice,
    { mode: "pushToTalk", muted: true, volume: 0.25 },
  ])("%o reaches the voice", (settings) => {
    const applied: { mode?: VoiceMode; muted?: boolean; volume?: number } = {};
    applyVoiceSettings(
      {
        setMode: (mode) => {
          applied.mode = mode;
        },
        setMuted: (muted) => {
          applied.muted = muted;
        },
        setVolume: (volume) => {
          applied.volume = volume;
        },
      },
      settings,
    );
    expect(applied).toEqual(settings);
  });

  test("a voice starts in the mode it is given", () => {
    const voice = createNullVoice({
      ...DEFAULT_SETTINGS.voice,
      mode: "pushToTalk",
    });
    expect(voice.status().mode).toBe("pushToTalk");
  });
});

describe("per-peer mute", () => {
  const MIX = { volume: 0.5, pan: -0.25 };

  test.each([
    [false, 0.5],
    [true, 0],
  ])("muted %s plays at gain %s", (muted, gain) => {
    expect(peerGain(MIX, muted)).toBe(gain);
  });

  test("a mix update after muting keeps the gain at 0, and keeps the pan", () => {
    const levels = createPeerLevels();
    levels.setMuted("player-a", true);
    levels.setMix("player-a", { volume: 0.5, pan: 0.75 });
    expect(levels.levels("player-a")).toEqual({ gain: 0, pan: 0.75 });
  });

  test("unmuting restores the latest mix volume", () => {
    const levels = createPeerLevels();
    levels.setMuted("player-a", true);
    levels.setMix("player-a", MIX);
    levels.setMuted("player-a", false);
    expect(levels.levels("player-a")).toEqual({ gain: 0.5, pan: -0.25 });
  });

  test("a mute set before the peer has a mix applies, and outlasts the peer leaving", () => {
    const levels = createPeerLevels();
    levels.setMuted("player-a", true);
    expect(levels.levels("player-a").gain).toBe(0);
    levels.setMix("player-a", MIX);
    levels.forget("player-a");
    expect(levels.levels("player-a")).toEqual({ gain: 0, pan: 0 });
    expect(levels.mutedPeers()).toEqual(["player-a"]);
  });

  test("muting one peer leaves the others alone", () => {
    const levels = createPeerLevels();
    levels.setMuted("player-a", true);
    levels.setMix("player-c", MIX);
    expect(levels.levels("player-c").gain).toBe(0.5);
    expect(levels.mutedPeers()).toEqual(["player-a"]);
  });
});

describe("null voice", () => {
  test("satisfies the port and stays inert", () => {
    const voice: Voice = createNullVoice(DEFAULT_SETTINGS.voice);
    const sent: unknown[] = [];
    voice.requestMic();
    voice.join(ME, {
      send: (_event, payload) => {
        sent.push(payload);
        return Promise.resolve();
      },
    });
    voice.addPeer("player-a");
    voice.receive({ from: "player-a", to: ME, description: OFFER });
    voice.setTalking(true);
    voice.setMuted(false);
    voice.setVolume(0.5);
    voice.setPeerMix("player-a", { volume: 0.2, pan: -1 });
    voice.removePeer("player-a");
    voice.leave();
    expect(sent).toEqual([]);
    expect(voice.status()).toEqual({
      mode: "open",
      mic: "unavailable",
      transmitting: false,
      peers: [],
      mutedPeers: [],
    });
  });

  test("ignores per-peer mute and reports no muted peers", () => {
    const voice = createNullVoice(DEFAULT_SETTINGS.voice);
    voice.setPeerMuted("player-a", true);
    voice.setPeerMix("player-a", { volume: 0.5, pan: 0 });
    expect(voice.status().mutedPeers).toEqual([]);
    expect(voice.status().peers).toEqual([]);
  });

  test("reports the mode it was given", () => {
    const voice = createNullVoice(DEFAULT_SETTINGS.voice);
    voice.setMode("pushToTalk");
    expect(voice.status().mode).toBe("pushToTalk");
  });
});
