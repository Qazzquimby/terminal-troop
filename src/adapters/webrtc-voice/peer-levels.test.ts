import { describe, expect, test } from "vitest";
import { createPeerLevels, peerGain } from "./peer-levels.js";

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

  test("a peer without a mix is silent and centred", () => {
    expect(createPeerLevels().levels("player-a")).toEqual({ gain: 0, pan: 0 });
  });

  test("forgetting every mix silences all peers but keeps the mutes", () => {
    const levels = createPeerLevels();
    levels.setMix("player-a", MIX);
    levels.setMuted("player-c", true);
    levels.forgetMixes();
    expect(levels.levels("player-a")).toEqual({ gain: 0, pan: 0 });
    expect(levels.mutedPeers()).toEqual(["player-c"]);
  });

  test("muting one peer leaves the others alone", () => {
    const levels = createPeerLevels();
    levels.setMuted("player-a", true);
    levels.setMix("player-c", MIX);
    expect(levels.levels("player-c").gain).toBe(0.5);
    expect(levels.mutedPeers()).toEqual(["player-a"]);
  });
});
