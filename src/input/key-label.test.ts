import { expect, test } from "vitest";
import { ACTIONS, actionKeyLabel, keyLabel } from "./actions.js";

test.each([
  ["KeyX", "X"],
  ["KeyV", "V"],
  ["Digit7", "7"],
  ["ShiftLeft", "Shift"],
  ["ShiftRight", "Shift"],
  ["Escape", "Esc"],
  ["MouseLeft", "Click"],
  ["MouseRight", "Right click"],
  ["F1", "F1"],
  ["F12", "F12"],
  ["ArrowUp", "↑"],
  ["ArrowDown", "↓"],
  ["ArrowLeft", "←"],
  ["ArrowRight", "→"],
  ["Tab", "Tab"],
  ["Space", "Space"],
  ["NumpadEnter", "NumpadEnter"],
])("keyLabel(%s) is %s", (code, label) => {
  expect(keyLabel(code)).toBe(label);
});

test("actionKeyLabel labels the action's first key", () => {
  expect(actionKeyLabel("pushToTalk")).toBe(
    keyLabel(ACTIONS.pushToTalk.keys[0]),
  );
});
