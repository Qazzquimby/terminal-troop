import { describe, expect, test } from "vitest";
import type { VoiceClipConfig } from "../../voice/index.js";
import { IDLE, nextCut, toBase64 } from "./clips.js";
import type { Cut, CutAct } from "./clips.js";

const CONFIG: VoiceClipConfig = {
  threshold: 0.4,
  quietSeconds: 0.6,
  minSeconds: 1.5,
  maxSeconds: 5,
  keep: 8,
  bitsPerSecond: 32_000,
  pollMs: 50,
};

/** Runs the cutter over `levels`, one a tenth of a second apart, live throughout unless told. */
function cuts(
  levels: readonly number[],
  live: (index: number) => boolean = () => true,
): CutAct[] {
  let cut: Cut = IDLE;
  return levels.map((level, index) => {
    const next = nextCut(cut, level, live(index), index / 10, CONFIG);
    cut = next.cut;
    return next.act;
  });
}

const repeat = <T>(value: T, times: number): T[] =>
  Array.from({ length: times }, () => value);

describe("cutting clips between pauses", () => {
  test("speech starts a clip, and a pause past the quiet spell ends it, kept", () => {
    const acts = cuts([0, ...repeat(0.6, 20), ...repeat(0.1, 7)]);
    expect(acts[1]).toBe("start");
    expect(acts.filter((act) => act === "keep")).toHaveLength(1);
    // Last loud at 2s, so 0.6s on.
    expect(acts.indexOf("keep")).toBe(26);
  });

  test("a gap between words shorter than the quiet spell does not end it", () => {
    const acts = cuts([
      ...repeat(0.6, 10),
      ...repeat(0.1, 4),
      ...repeat(0.6, 10),
      ...repeat(0.1, 7),
    ]);
    expect(acts.filter((act) => act === "start")).toHaveLength(1);
    expect(acts.filter((act) => act !== null)).toEqual(["start", "keep"]);
  });

  test("a word too short to keep is thrown away", () => {
    const acts = cuts([...repeat(0.6, 3), ...repeat(0.1, 7)]);
    expect(acts.filter((act) => act !== null)).toEqual(["start", "discard"]);
  });

  test("a clip holds at least 1.5s of speech: 1.4s is thrown away, 1.5s kept", () => {
    const cutsWith = (loud: number) =>
      cuts([...repeat(0.6, loud), ...repeat(0.1, 7)]).filter(
        (act) => act !== null,
      );
    // Loud from 0 to 1.4s, then from 0 to 1.5s.
    expect(cutsWith(15)).toEqual(["start", "discard"]);
    expect(cutsWith(16)).toEqual(["start", "keep"]);
  });

  test("a clip is cut off at its longest", () => {
    const acts = cuts(repeat(0.6, 60));
    expect(acts[0]).toBe("start");
    expect(acts[50]).toBe("keep");
    expect(acts[51]).toBe("start");
  });

  test("nothing starts while the mic goes out to no one, and a clip ends the moment it stops", () => {
    expect(
      cuts(repeat(0.9, 20), () => false).every((act) => act === null),
    ).toBe(true);
    // Muted, or push-to-talk let go, 1.7s in: the clip ends then, kept for the speech it held.
    const acts = cuts(repeat(0.9, 20), (index) => index < 17);
    expect(acts.filter((act) => act !== null)).toEqual(["start", "keep"]);
    expect(acts[17]).toBe("keep");
  });
});

test("bytes go to base64 as btoa has them, however many there are", () => {
  const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  expect(toBase64(bytes)).toBe(btoa(binary));
});
