import { expect, test } from "vitest";
import type { Action, InputContext } from "./actions.js";
import {
  createActionState,
  isActiveIn,
  toControls,
  withUiHandlers,
} from "./actions.js";

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

const CONTEXTS: InputContext[] = ["play", "menu", "text"];

test.each<[Action, InputContext[]]>([
  ["moveUp", ["play"]],
  ["moveLeft", ["play"]],
  ["moveDown", ["play"]],
  ["moveRight", ["play"]],
  ["sprint", ["play"]],
  ["toggleInventory", ["play"]],
  ["toggleSettings", ["play", "menu"]],
  ["toggleDebug", ["play", "menu"]],
  ["pushToTalk", ["play", "menu"]],
])("%s is active only in %o", (action, active) => {
  for (const context of CONTEXTS)
    expect(isActiveIn(action, context)).toBe(active.includes(context));
});

/** A UI-handled action state that records every handler call. */
function uiInput() {
  const state = createActionState();
  const calls: (
    ["press", Action, number] | ["held", Action, boolean, number]
  )[] = [];
  const record = (action: Action) => ({
    press: (time: number) => calls.push(["press", action, time]),
    held: (held: boolean, time: number) =>
      calls.push(["held", action, held, time]),
  });
  const sink = withUiHandlers(state, {
    toggleInventory: { press: record("toggleInventory").press },
    pushToTalk: { held: record("pushToTalk").held },
    sprint: record("sprint"),
  });
  return { state, sink, calls };
}

test("every event still reaches the action state", () => {
  const { state, sink } = uiInput();
  sink.press("toggleInventory", 1);
  sink.press("moveUp", 1);
  sink.resume("sprint", 1);
  sink.release("toggleInventory", 2);
  const first = step(state, 2).frame;
  expect(first.pressed).toEqual(actions("toggleInventory", "moveUp"));
  expect(first.released).toEqual(actions("toggleInventory"));
  sink.clear(3);
  expect(step(state, 3).frame.released).toEqual(actions("moveUp", "sprint"));
});

test("a toggle press handler runs on press, not on resume", () => {
  const { sink, calls } = uiInput();
  sink.press("toggleInventory", 1);
  sink.release("toggleInventory", 2);
  sink.resume("toggleInventory", 3);
  sink.clear(4);
  sink.press("toggleInventory", 5);
  expect(calls).toEqual([
    ["press", "toggleInventory", 1],
    ["press", "toggleInventory", 5],
  ]);
});

test("held goes true on press and false on release", () => {
  const { sink, calls } = uiInput();
  sink.press("pushToTalk", 1);
  sink.release("pushToTalk", 2);
  expect(calls).toEqual([
    ["held", "pushToTalk", true, 1],
    ["held", "pushToTalk", false, 2],
  ]);
});

test("held goes true on resume without a press call", () => {
  const { sink, calls } = uiInput();
  sink.resume("sprint", 1);
  expect(calls).toEqual([["held", "sprint", true, 1]]);
});

test("clear ends held only for actions that are held", () => {
  const { sink, calls } = uiInput();
  sink.press("sprint", 1);
  sink.press("pushToTalk", 1);
  sink.release("pushToTalk", 2);
  calls.length = 0;
  sink.clear(3);
  expect(calls).toEqual([["held", "sprint", false, 3]]);
});

test("held reports only real transitions", () => {
  const { sink, calls } = uiInput();
  sink.release("sprint", 1);
  sink.press("sprint", 2);
  sink.press("sprint", 3);
  sink.resume("sprint", 4);
  sink.release("sprint", 5);
  sink.release("sprint", 6);
  sink.clear(7);
  expect(calls).toEqual([
    ["press", "sprint", 2],
    ["held", "sprint", true, 2],
    ["held", "sprint", false, 5],
  ]);
});
