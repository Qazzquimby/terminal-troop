import { describe, expect, test } from "vitest";
import { createActionState, withUiHandlers } from "../input/index.js";
import { DEFAULT_SETTINGS } from "../settings/index.js";
import type { Voice, VoiceMode, VoiceSettings } from "./voice.js";
import { applyVoiceSettings, createNullVoice, pushToTalk } from "./voice.js";

const ME = "player-b";
const OFFER = { type: "offer", sdp: "v=0\r\n" };
/** An action state whose push-to-talk handlers drive a voice that records each talk change. */
function talkInput() {
  const talk: boolean[] = [];
  const voice = createNullVoice(DEFAULT_SETTINGS.voice);
  voice.setTalking = (held) => talk.push(held);
  const state = createActionState();
  const sink = withUiHandlers(state, {
    pushToTalk: pushToTalk(voice),
  });
  return { talk, state, sink };
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

  test("talks from press to release", () => {
    const input = talkInput();
    input.sink.press("pushToTalk", 1);
    expect(input.talk).toEqual([true]);
    input.sink.release("pushToTalk", 2);
    expect(input.talk).toEqual([true, false]);
  });

  test("stops talking on clear, and the state releases it", () => {
    const input = talkInput();
    input.sink.press("pushToTalk", 1);
    input.sink.clear(3);
    expect(input.talk).toEqual([true, false]);
    const frame = input.state.consume(3);
    expect(frame.released.has("pushToTalk")).toBe(true);
    expect(frame.held.has("pushToTalk")).toBe(false);
  });

  test("talks again on resume after a clear", () => {
    const input = talkInput();
    input.sink.press("pushToTalk", 1);
    input.sink.clear(2);
    input.sink.resume("pushToTalk", 3);
    input.sink.release("pushToTalk", 4);
    expect(input.talk).toEqual([true, false, true, false]);
  });

  test("clear while not talking changes nothing", () => {
    const input = talkInput();
    input.sink.clear(1);
    expect(input.talk).toEqual([]);
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
      mode: "pushToTalk",
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
