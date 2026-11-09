import { describe, expect, it } from "vitest";
import {
  voiceMix,
  VOICE_FULL_DISTANCE,
  VOICE_PAN_DISTANCE,
  VOICE_SILENT_DISTANCE,
} from "./voice-proximity.js";

const listener = { x: 1000, y: 1000 };
const at = (dx: number, dy = 0) => ({ x: listener.x + dx, y: listener.y + dy });

describe("voiceMix", () => {
  it("is full volume close by", () => {
    expect(voiceMix(listener, listener).volume).toBe(1);
    expect(voiceMix(listener, at(0, VOICE_FULL_DISTANCE)).volume).toBe(1);
  });

  it("is silent far away", () => {
    expect(voiceMix(listener, at(0, VOICE_SILENT_DISTANCE)).volume).toBe(0);
    expect(voiceMix(listener, at(0, VOICE_SILENT_DISTANCE * 3)).volume).toBe(0);
  });

  it("falls off monotonically between", () => {
    const volumes = [100, 200, 300, 400, 500, 600].map(
      (d) => voiceMix(listener, at(0, d)).volume,
    );
    for (let i = 1; i < volumes.length; i++) {
      expect(volumes[i]).toBeLessThan(volumes[i - 1] ?? Infinity);
    }
    expect(voiceMix(listener, at(0, 350)).volume).toBeCloseTo(0.5);
  });

  it("pans towards the speaker's side", () => {
    expect(voiceMix(listener, at(-100)).pan).toBeLessThan(0);
    expect(voiceMix(listener, at(100)).pan).toBeGreaterThan(0);
    expect(voiceMix(listener, at(0, 200)).pan).toBe(0);
  });

  it("saturates pan at the pan distance", () => {
    expect(voiceMix(listener, at(VOICE_PAN_DISTANCE)).pan).toBe(1);
    expect(voiceMix(listener, at(-VOICE_PAN_DISTANCE * 2)).pan).toBe(-1);
  });
});
