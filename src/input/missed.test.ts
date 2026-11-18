import { expect, test } from "vitest";
import { ACTIONS, createActionState } from "./actions.js";
import { createButtonSource } from "./buttons.js";
import { upKeys } from "./missed.js";

const nothing = {
  buttons: 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
};

test("every button and modifier is up while an event shows none down", () => {
  expect(upKeys(nothing)).toEqual(
    expect.arrayContaining([
      "MouseLeft",
      "MouseMiddle",
      "MouseRight",
      "ShiftLeft",
      "ShiftRight",
    ]),
  );
});

test("a button or modifier an event shows down is not up", () => {
  // `buttons` has the right button as 2 and the middle as 4, unlike `button`.
  const up = upKeys({ ...nothing, buttons: 2, shiftKey: true });
  expect(up).not.toContain("MouseRight");
  expect(up).not.toContain("ShiftLeft");
  expect(up).toContain("MouseLeft");
  expect(up).toContain("MouseMiddle");
  expect(upKeys({ ...nothing, buttons: 4 })).not.toContain("MouseMiddle");
});

test("Shift and a right click whose release the browser's menu took are both let go at the next move", () => {
  const state = createActionState();
  const source = createButtonSource(state, ACTIONS, "play");
  source.keyDown("ShiftLeft", false, 0);
  source.keyDown("MouseRight", false, 0);
  expect(source.actionsFor("MouseRight")).toEqual(["secondary"]);
  // No pointerup nor keyup came; the next move shows nothing down.
  const freed = upKeys(nothing).flatMap((code) => source.keyUp(code, 10));
  expect(freed).toEqual(expect.arrayContaining(["sprint", "secondary"]));
});
