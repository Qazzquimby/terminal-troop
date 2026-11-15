import { expect, test } from "vitest";
import { ACTIONS } from "../input/index.js";
import type { Bindings } from "../input/index.js";
import {
  CONTROLS_HINT,
  controlsHintFor,
  controlsHintText,
  hintMode,
} from "./controls-hint.js";

const rebind = (changes: Partial<Bindings>): Bindings => ({
  ...ACTIONS,
  ...changes,
});

test("the hint matches the default bindings", () => {
  expect(controlsHintFor("foot", false)).toBe(
    "WASD / ↑←↓→ to move · Shift to sprint · C to toggle crouch · Click to use · " +
      "Right click to kick · E to pick up / get in / work item · F to drop · Scroll to switch item · Esc for settings",
  );
});

test("at the wheel it shows driving controls", () => {
  expect(controlsHintFor("driving", false)).toBe(
    "WASD / ↑←↓→ to drive · Space to honk · E to let go of the wheel · Esc for settings",
  );
});

test("in the cabin it shows how to take the wheel and transmit", () => {
  expect(controlsHintFor("cabin", false)).toBe(
    "E to take the wheel · T (hold) to transmit · Esc for settings",
  );
});

test("a ghost is shown only how to spectate", () => {
  const text = controlsHintFor("ghost", false);
  expect(text).toBe(
    "Click to watch next · Right click to watch previous · Space to toggle free camera · " +
      "WASD / ↑←↓→ to move free camera · Esc for settings",
  );
  expect(text).not.toMatch(/pick up|kick|drop/);
});

test("push to talk adds the talk key", () => {
  expect(controlsHintFor("ghost", true)).toMatch(/ · V to talk$/);
});

test("the mode follows the local player", () => {
  expect(hintMode({ health: 3, ride: null })).toBe("foot");
  const ride = { vehicle: "car", heading: 0, speed: 0, turn: 0 };
  expect(hintMode({ health: 3, ride: { ...ride, driving: true } })).toBe(
    "driving",
  );
  expect(hintMode({ health: 3, ride: { ...ride, driving: false } })).toBe(
    "cabin",
  );
  expect(hintMode({ health: 0, ride: null })).toBe("ghost");
});

test("changing a binding changes the text", () => {
  const text = controlsHintText(
    [{ actions: ["crouch"], does: "to toggle crouch" }],
    rebind({ crouch: { keys: ["KeyX"] } }),
  );
  expect(text).toBe("X to toggle crouch");
});

test("several bindings for one action are joined", () => {
  const text = controlsHintText(
    [{ actions: ["crouch"], does: "to toggle crouch" }],
    rebind({ crouch: { keys: ["KeyC", "ControlLeft"] } }),
  );
  expect(text).toBe("C / ControlLeft to toggle crouch");
});

test("an action missing from the list does not appear", () => {
  const text = controlsHintText([{ actions: ["sprint"], does: "to sprint" }]);
  expect(text).toBe("Shift to sprint");
  for (const entries of Object.values(CONTROLS_HINT))
    expect(controlsHintText(entries)).not.toMatch(/F3|debug/);
});
