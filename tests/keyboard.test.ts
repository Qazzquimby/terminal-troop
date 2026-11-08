import { expect, test } from "vitest";
import type { Action, ActionSink } from "../src/engine/actions.js";
import { createKeyboardSource } from "../src/engine/keyboard.js";

const TEST_BINDINGS = {
  moveUp: ["up-key"],
  moveRight: ["right-key"],
  sprint: ["sprint-a", "sprint-b"],
  toggleInventory: ["menu-key"],
};

type Call =
  [Exclude<keyof ActionSink, "clear">, Action, number] | ["clear", number];

/** A sink that records every call, with its time, in order. */
function recorder() {
  const calls: Call[] = [];
  const sink: ActionSink = {
    press: (action, time) => calls.push(["press", action, time]),
    release: (action, time) => calls.push(["release", action, time]),
    resume: (action, time) => calls.push(["resume", action, time]),
    clear: (time) => calls.push(["clear", time]),
  };
  return { calls, keyboard: createKeyboardSource(sink, TEST_BINDINGS) };
}

test("a key maps to its action, passing the event time through", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.actionsFor("right-key")).toEqual(["moveRight"]);
  expect(keyboard.keyDown("right-key", false, 10)).toEqual(["moveRight"]);
  expect(keyboard.keyUp("right-key", 20)).toEqual(["moveRight"]);
  expect(calls).toEqual([
    ["press", "moveRight", 10],
    ["release", "moveRight", 20],
  ]);
});

test("two keys on one action press on the first and release on the last", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.keyDown("sprint-a", false, 1)).toEqual(["sprint"]);
  expect(keyboard.keyDown("sprint-b", false, 2)).toEqual([]);
  expect(keyboard.keyUp("sprint-a", 3)).toEqual([]);
  expect(calls).toEqual([["press", "sprint", 1]]);
  expect(keyboard.keyUp("sprint-b", 4)).toEqual(["sprint"]);
  expect(calls).toEqual([
    ["press", "sprint", 1],
    ["release", "sprint", 4],
  ]);
});

test("key repeat does not press again", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("up-key", false, 1);
  expect(keyboard.keyDown("up-key", true, 2)).toEqual([]);
  expect(keyboard.keyDown("up-key", true, 3)).toEqual([]);
  expect(calls).toEqual([["press", "moveUp", 1]]);
});

test("a key still held after blur is restored by auto-repeat without a press", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("right-key", false, 1);
  keyboard.blur(2);
  expect(keyboard.keyDown("right-key", true, 3)).toEqual([]);
  expect(calls).toEqual([
    ["press", "moveRight", 1],
    ["clear", 2],
    ["resume", "moveRight", 3],
  ]);
  expect(keyboard.keyUp("right-key", 4)).toEqual(["moveRight"]);
});

test("unbound keys are ignored", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.actionsFor("other-key")).toEqual([]);
  expect(keyboard.keyDown("other-key", false, 1)).toEqual([]);
  expect(keyboard.keyDown("other-key", true, 2)).toEqual([]);
  expect(keyboard.keyUp("other-key", 3)).toEqual([]);
  expect(calls).toEqual([]);
});

test("a key up without a key down releases nothing", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.keyUp("menu-key", 1)).toEqual([]);
  expect(calls).toEqual([]);
});

test("blur forgets held keys and forwards to the sink", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("up-key", false, 1);
  keyboard.blur(2);
  expect(keyboard.keyUp("up-key", 3)).toEqual([]);
  expect(keyboard.keyDown("up-key", false, 4)).toEqual(["moveUp"]);
  expect(calls).toEqual([
    ["press", "moveUp", 1],
    ["clear", 2],
    ["press", "moveUp", 4],
  ]);
});
