import { describe, expect, test } from "vitest";
import { captureMode, createCaptureControl } from "./capture.js";
import type { CaptureMode } from "./capture.js";
import { moveCursor } from "./turn.js";

const playing = { playing: true, ui: false, turning: false };

describe("captureMode", () => {
  test("outside a room, or with a menu or a cabin up, the mouse is free", () => {
    expect(captureMode({ ...playing, playing: false })).toBe("free");
    expect(captureMode({ ...playing, ui: true })).toBe("free");
    expect(captureMode({ ...playing, ui: true, turning: true })).toBe("free");
  });

  test("playing, it turns the view with the rotating camera, and points otherwise (#496)", () => {
    expect(captureMode({ ...playing, turning: true })).toBe("turn");
    expect(captureMode(playing)).toBe("point");
  });
});

/** A capture control over a fake input that records what it is asked. */
function recorded() {
  const calls: string[] = [];
  const control = createCaptureControl({
    setCapture(mode: CaptureMode) {
      calls.push(`set ${mode}`);
    },
    reclaim() {
      calls.push("reclaim");
    },
  });
  return { calls, control };
}

describe("createCaptureControl", () => {
  test("coming back from a menu or a vehicle gives the game focus and asks for the mouse (#503)", () => {
    const { calls, control } = recorded();
    control.sync("turn");
    expect(calls).toEqual(["set turn", "reclaim"]);
    calls.length = 0;
    // Settings opened, or a vehicle got into: the mouse is let go.
    control.sync("free");
    expect(calls).toEqual(["set free"]);
    calls.length = 0;
    // Settings closed, or the vehicle got out of.
    control.sync("turn");
    expect(calls).toEqual(["set turn", "reclaim"]);
  });

  test("the pointing cursor is reclaimed the same way (#496)", () => {
    const { calls, control } = recorded();
    control.sync("free");
    control.sync("point");
    expect(calls).toEqual(["set free", "set point", "reclaim"]);
  });

  test("staying captured, or switching between turning and pointing, asks nothing again", () => {
    const { calls, control } = recorded();
    control.sync("turn");
    calls.length = 0;
    control.sync("turn");
    control.sync("point");
    expect(calls).toEqual(["set turn", "set point"]);
    expect(control.mode()).toBe("point");
  });
});

describe("moveCursor", () => {
  const at = { x: 100, y: 100 };

  test("moves with the mouse, scaled", () => {
    expect(moveCursor(at, 10, -5, 2, 900, 600, 300)).toEqual({ x: 120, y: 90 });
  });

  test("stays within the view", () => {
    expect(moveCursor(at, -500, 900, 1, 900, 600, 1000)).toEqual({
      x: 0,
      y: 600,
    });
  });

  test("drops a spike, as turning does", () => {
    expect(moveCursor(at, 400, 3, 1, 900, 600, 300)).toEqual({
      x: 100,
      y: 103,
    });
  });
});
