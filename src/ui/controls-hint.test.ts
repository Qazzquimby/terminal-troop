import { expect, test } from "vitest";
import { ACTIONS } from "../input/index.js";
import type { Bindings } from "../input/index.js";
import { CONTROLS_HINT, controlsHintText } from "./controls-hint.js";

const rebind = (changes: Partial<Bindings>): Bindings => ({
  ...ACTIONS,
  ...changes,
});

test("the hint matches the default bindings", () => {
  expect(controlsHintText(CONTROLS_HINT)).toBe(
    "WASD / ↑←↓→ to move · Shift to sprint · C to toggle crouch · " +
      "Right click to kick · E to pick up or drop · Tab to toggle inventory · " +
      "Esc for settings",
  );
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
  expect(controlsHintText(CONTROLS_HINT)).not.toMatch(/F3|debug/);
});
