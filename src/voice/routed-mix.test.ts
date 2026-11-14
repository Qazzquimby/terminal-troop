import { describe, expect, test } from "vitest";
import { routedMix, voiceMix } from "./voice-proximity.js";

const air = { full: 100, silent: 600, pan: 300 };
const falloff = { ...air, radio: { full: 50, silent: 400, pan: 300 } };
const listener = { x: 0, y: 0 };

describe("routedMix", () => {
  test("through the air alone, it is the proximity mix, with no radio part", () => {
    const at = { x: 350, y: 0 };
    expect(routedMix(listener, [{ at, via: "air" }], falloff)).toEqual(
      voiceMix(listener, at, falloff),
    );
  });

  test("with no route at all, it is silent", () => {
    expect(routedMix(listener, [], falloff)).toEqual({ volume: 0, pan: 0 });
  });

  test("of several routes each way, the loudest is heard, a radio one by the radio falloff", () => {
    const mix = routedMix(
      listener,
      [
        { at: { x: 700, y: 0 }, via: "air" },
        { at: { x: -300, y: 0 }, via: "radio" },
        { at: { x: 1000, y: 0 }, via: "radio" },
        { at: { x: 0, y: 1000 }, via: "radio" },
      ],
      falloff,
    );
    expect(mix.volume).toBe(0);
    expect(mix.radio?.volume).toBeCloseTo(1 - 250 / 350);
    expect(mix.radio?.pan).toBe(-1);
  });

  test("a radio route falls off as the air does when no radio falloff is given", () => {
    const at = { x: 350, y: 0 };
    expect(routedMix(listener, [{ at, via: "radio" }], air).radio).toEqual(
      voiceMix(listener, at, air),
    );
  });

  test("a route from no place is heard in full, centred", () => {
    expect(
      routedMix(listener, [{ at: null, via: "radio" }], falloff).radio,
    ).toEqual({ volume: 1, pan: 0 });
  });
});
