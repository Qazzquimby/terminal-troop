import { expect, test } from "vitest";
import type { Action } from "../src/engine/actions.js";
import { createActionState, toControls } from "../src/engine/actions.js";

const AIM = { x: 0, y: 0 };

function step(state: ReturnType<typeof createActionState>) {
  const frame = state.consume();
  return { frame, controls: toControls(frame, AIM) };
}

function holding(...codes: string[]) {
  const state = createActionState();
  for (const code of codes) state.keyDown(code, false);
  return state;
}

test("held actions stay held across steps", () => {
  const state = holding("KeyD");
  for (let i = 0; i < 3; i++) {
    const { frame, controls } = step(state);
    expect(frame.held.has("moveRight")).toBe(true);
    expect(controls.move).toEqual({ x: 1, y: 0 });
  }
});

test("a tap between steps registers as pressed and released exactly once", () => {
  const state = createActionState();
  state.keyDown("Tab", false);
  state.keyUp("Tab");
  const first = step(state).frame;
  expect(first.pressed).toEqual(new Set<Action>(["toggleInventory"]));
  expect(first.released).toEqual(new Set<Action>(["toggleInventory"]));
  expect(first.held.size).toBe(0);
  const second = step(state).frame;
  expect(second.pressed.size).toBe(0);
  expect(second.released.size).toBe(0);
});

test("releasing a held key is reported in one step", () => {
  const state = holding("KeyD");
  step(state);
  state.keyUp("KeyD");
  expect(step(state).frame.released).toEqual(new Set<Action>(["moveRight"]));
  expect(step(state).frame.released.size).toBe(0);
});

test("key repeat does not press again", () => {
  const state = holding("KeyW");
  step(state);
  expect(state.keyDown("KeyW", true)).toEqual([]);
  expect(step(state).frame.pressed.size).toBe(0);
});

test("releasing one of two keys bound to an action keeps it held", () => {
  const state = holding("ShiftLeft");
  expect(state.keyDown("ShiftRight", false)).toEqual([]);
  state.keyUp("ShiftLeft");
  const stillHeld = step(state);
  expect(stillHeld.controls.sprint).toBe(true);
  expect(stillHeld.frame.released.size).toBe(0);
  state.keyUp("ShiftRight");
  const letGo = step(state);
  expect(letGo.controls.sprint).toBe(false);
  expect(letGo.frame.released).toEqual(new Set<Action>(["sprint"]));
});

test("blur clears held and pressed actions and releases held ones", () => {
  const state = holding("KeyW", "ShiftLeft");
  state.clear();
  const { frame, controls } = step(state);
  expect(frame.held.size).toBe(0);
  expect(frame.pressed.size).toBe(0);
  expect(frame.released).toEqual(new Set<Action>(["moveUp", "sprint"]));
  expect(controls).toEqual({ move: { x: 0, y: 0 }, aim: AIM, sprint: false });
});

test("opposite move directions cancel", () => {
  expect(step(holding("KeyA", "ArrowRight")).controls.move).toEqual({
    x: 0,
    y: 0,
  });
  expect(step(holding("ArrowUp", "KeyS")).controls.move).toEqual({
    x: 0,
    y: 0,
  });
});

test("diagonal movement is normalized", () => {
  const { move } = step(holding("KeyW", "KeyD")).controls;
  expect(Math.hypot(move.x, move.y)).toBeCloseTo(1);
  expect(move.x).toBeCloseTo(Math.SQRT1_2);
  expect(move.y).toBeCloseTo(-Math.SQRT1_2);
});
