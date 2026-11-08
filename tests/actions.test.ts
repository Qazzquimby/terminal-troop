import { expect, test } from "vitest";
import type { Action } from "../src/engine/actions.js";
import {
  IDLE_FRAME,
  createActionState,
  toControls,
} from "../src/engine/actions.js";

const AIM = { x: 0, y: 0 };

type ActionState = ReturnType<typeof createActionState>;

function step(state: ActionState, until = 1000) {
  const frame = state.consume(until);
  return { frame, controls: toControls(frame, AIM) };
}

function holding(...actions: Action[]) {
  const state = createActionState();
  for (const action of actions) state.press(action, 0);
  return state;
}

const actions = (...list: Action[]) => new Set<Action>(list);

test("held actions stay held across steps", () => {
  const state = holding("moveRight");
  for (let i = 0; i < 3; i++) {
    const { frame, controls } = step(state);
    expect(frame.held.has("moveRight")).toBe(true);
    expect(controls.move).toEqual({ x: 1, y: 0 });
  }
});

test("a press is reported in one step only", () => {
  const state = holding("moveRight");
  expect(step(state).frame.pressed).toEqual(actions("moveRight"));
  expect(step(state).frame.pressed.size).toBe(0);
});

test("a tap between steps registers as pressed and released exactly once", () => {
  const state = createActionState();
  state.press("toggleInventory", 1);
  state.release("toggleInventory", 2);
  const first = step(state).frame;
  expect(first.pressed).toEqual(actions("toggleInventory"));
  expect(first.released).toEqual(actions("toggleInventory"));
  expect(first.held.size).toBe(0);
  const second = step(state).frame;
  expect(second.pressed.size).toBe(0);
  expect(second.released.size).toBe(0);
});

test("a release is reported in one step", () => {
  const state = holding("moveRight");
  step(state, 10);
  state.release("moveRight", 20);
  const { frame, controls } = step(state, 30);
  expect(frame.released).toEqual(actions("moveRight"));
  expect(controls.move).toEqual({ x: 0, y: 0 });
  expect(step(state, 40).frame.released.size).toBe(0);
});

test("releasing an action that is not held does nothing", () => {
  const state = createActionState();
  state.release("sprint", 0);
  expect(step(state).frame.released.size).toBe(0);
});

test("pressing an already-held action is a no-op", () => {
  const state = holding("moveUp");
  step(state, 10);
  state.press("moveUp", 20);
  const { frame } = step(state, 30);
  expect(frame.pressed.size).toBe(0);
  expect(frame.held.has("moveUp")).toBe(true);
});

test("resuming holds an action without pressing it", () => {
  const state = createActionState();
  state.resume("moveRight", 0);
  const { frame, controls } = step(state);
  expect(frame.pressed.size).toBe(0);
  expect(frame.held.has("moveRight")).toBe(true);
  expect(controls.move).toEqual({ x: 1, y: 0 });
});

test("blur releases held actions and drops pending presses", () => {
  const state = holding("moveUp", "sprint");
  state.clear(1);
  const { frame, controls } = step(state);
  expect(frame.held.size).toBe(0);
  expect(frame.pressed.size).toBe(0);
  expect(frame.released).toEqual(actions("moveUp", "sprint"));
  expect(controls).toEqual({ move: { x: 0, y: 0 }, aim: AIM, sprint: false });
});

test("an event after the step's end stays queued for a later step", () => {
  const state = createActionState();
  state.press("moveLeft", 50);
  const early = step(state, 40).frame;
  expect(early.held.size).toBe(0);
  expect(early.pressed.size).toBe(0);
  const late = step(state, 60).frame;
  expect(late.pressed).toEqual(actions("moveLeft"));
  expect(late.held).toEqual(actions("moveLeft"));
});

test("events inside one step apply in time order", () => {
  const state = createActionState();
  state.press("moveUp", 10);
  state.clear(20);
  state.release("moveDown", 15);
  state.press("moveDown", 5);
  state.press("sprint", 30);
  const { frame } = step(state, 40);
  expect(frame.held).toEqual(actions("sprint"));
  expect(frame.pressed).toEqual(actions("sprint"));
  expect(frame.released).toEqual(actions("moveUp", "moveDown"));
});

test("a press and release inside one step show as both", () => {
  const state = createActionState();
  state.press("moveRight", 10);
  state.release("moveRight", 20);
  const { frame } = step(state, 25);
  expect(frame.pressed).toEqual(actions("moveRight"));
  expect(frame.released).toEqual(actions("moveRight"));
  expect(frame.held.size).toBe(0);
});

test("a step ending between a press and its release holds, then the next step releases", () => {
  const state = createActionState();
  state.press("moveRight", 10);
  state.release("moveRight", 20);
  const first = step(state, 15).frame;
  expect(first.held).toEqual(actions("moveRight"));
  expect(first.pressed).toEqual(actions("moveRight"));
  expect(first.released.size).toBe(0);
  const second = step(state, 25).frame;
  expect(second.held.size).toBe(0);
  expect(second.pressed.size).toBe(0);
  expect(second.released).toEqual(actions("moveRight"));
});

test("opposite move directions cancel", () => {
  expect(step(holding("moveLeft", "moveRight")).controls.move).toEqual({
    x: 0,
    y: 0,
  });
  expect(step(holding("moveUp", "moveDown")).controls.move).toEqual({
    x: 0,
    y: 0,
  });
});

test("diagonal movement is normalized", () => {
  const { move } = step(holding("moveUp", "moveRight")).controls;
  expect(Math.hypot(move.x, move.y)).toBeCloseTo(1);
  expect(move.x).toBeCloseTo(Math.SQRT1_2);
  expect(move.y).toBeCloseTo(-Math.SQRT1_2);
});

test("sprint follows the held sprint action", () => {
  expect(step(holding("moveRight")).controls.sprint).toBe(false);
  expect(step(holding("moveRight", "sprint")).controls.sprint).toBe(true);
});

test("an action held into a suspension and released during it is not held afterwards", () => {
  const state = holding("moveRight");
  expect(step(state, 10).controls.move.x).toBe(1);

  // Suspended: steps still consume, but the game sees the idle frame.
  state.release("moveRight", 20);
  state.consume(30);
  expect(toControls(IDLE_FRAME, AIM).move).toEqual({ x: 0, y: 0 });

  // Resumed: no drift, and the release is not replayed into a later step.
  const after = step(state, 40);
  expect(after.controls.move).toEqual({ x: 0, y: 0 });
  expect(after.frame.held).toEqual(actions());
  expect(after.frame.released).toEqual(actions());
});
