import { expect, test } from "vitest";
import type { ActionSink } from "../src/engine/actions.js";
import { createKeyboardSource } from "../src/engine/keyboard.js";

/** Made-up actions, keys and contexts: `pause` works in both contexts, the rest only in `field`. */
const TEST_BINDINGS = {
  up: { keys: ["up-key"], contexts: ["field"] },
  right: { keys: ["right-key"], contexts: ["field"] },
  dash: { keys: ["dash-a", "dash-b"], contexts: ["field"] },
  pause: { keys: ["pause-key"], contexts: ["field", "paused"] },
} as const;

type TestAction = keyof typeof TEST_BINDINGS;
type TestContext = "field" | "paused" | "typing";

type Call =
  [Exclude<keyof ActionSink, "clear">, TestAction, number] | ["clear", number];

/** A sink that records every call, with its time, in order. */
function recorder(context: TestContext = "field") {
  const calls: Call[] = [];
  const sink: ActionSink<TestAction> = {
    press: (action, time) => calls.push(["press", action, time]),
    release: (action, time) => calls.push(["release", action, time]),
    resume: (action, time) => calls.push(["resume", action, time]),
    clear: (time) => calls.push(["clear", time]),
  };
  return {
    calls,
    keyboard: createKeyboardSource<TestAction, TestContext>(
      sink,
      TEST_BINDINGS,
      context,
    ),
  };
}

test("a key maps to its action, passing the event time through", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.actionsFor("right-key")).toEqual(["right"]);
  expect(keyboard.keyDown("right-key", false, 10)).toEqual(["right"]);
  expect(keyboard.keyUp("right-key", 20)).toEqual(["right"]);
  expect(calls).toEqual([
    ["press", "right", 10],
    ["release", "right", 20],
  ]);
});

test("two keys on one action press on the first and release on the last", () => {
  const { calls, keyboard } = recorder();
  expect(keyboard.keyDown("dash-a", false, 1)).toEqual(["dash"]);
  expect(keyboard.keyDown("dash-b", false, 2)).toEqual([]);
  expect(keyboard.keyUp("dash-a", 3)).toEqual([]);
  expect(calls).toEqual([["press", "dash", 1]]);
  expect(keyboard.keyUp("dash-b", 4)).toEqual(["dash"]);
  expect(calls).toEqual([
    ["press", "dash", 1],
    ["release", "dash", 4],
  ]);
});

test("key repeat does not press again", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("up-key", false, 1);
  expect(keyboard.keyDown("up-key", true, 2)).toEqual([]);
  expect(keyboard.keyDown("up-key", true, 3)).toEqual([]);
  expect(calls).toEqual([["press", "up", 1]]);
});

test("a key still held after blur is restored by auto-repeat without a press", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("right-key", false, 1);
  keyboard.blur(2);
  expect(keyboard.keyDown("right-key", true, 3)).toEqual([]);
  expect(calls).toEqual([
    ["press", "right", 1],
    ["clear", 2],
    ["resume", "right", 3],
  ]);
  expect(keyboard.keyUp("right-key", 4)).toEqual(["right"]);
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
  expect(keyboard.keyUp("pause-key", 1)).toEqual([]);
  expect(calls).toEqual([]);
});

test("blur forgets held keys and forwards to the sink", () => {
  const { calls, keyboard } = recorder();
  keyboard.keyDown("up-key", false, 1);
  keyboard.blur(2);
  expect(keyboard.keyUp("up-key", 3)).toEqual([]);
  expect(keyboard.keyDown("up-key", false, 4)).toEqual(["up"]);
  expect(calls).toEqual([
    ["press", "up", 1],
    ["clear", 2],
    ["press", "up", 4],
  ]);
});

test("only keys whose action is active in the context are claimed and forwarded", () => {
  const { calls, keyboard } = recorder("paused");
  // `actionsFor` decides whether the key is kept from the page.
  expect(keyboard.actionsFor("right-key")).toEqual([]);
  expect(keyboard.actionsFor("pause-key")).toEqual(["pause"]);
  expect(keyboard.keyDown("right-key", false, 1)).toEqual([]);
  expect(keyboard.keyUp("right-key", 2)).toEqual([]);
  expect(keyboard.keyDown("pause-key", false, 3)).toEqual(["pause"]);
  expect(calls).toEqual([["press", "pause", 3]]);
});

test("a context with no actions claims no keys", () => {
  const { calls, keyboard } = recorder("typing");
  for (const code of ["up-key", "right-key", "dash-a", "pause-key"]) {
    expect(keyboard.actionsFor(code)).toEqual([]);
    expect(keyboard.keyDown(code, false, 1)).toEqual([]);
  }
  expect(calls).toEqual([]);
});

test("claimed keys follow a context switch", () => {
  const { keyboard } = recorder("field");
  expect(keyboard.actionsFor("up-key")).toEqual(["up"]);
  keyboard.setContext("paused", 1);
  expect(keyboard.actionsFor("up-key")).toEqual([]);
  keyboard.setContext("field", 2);
  expect(keyboard.actionsFor("up-key")).toEqual(["up"]);
});

test("a context switch releases held actions it deactivates, at the switch time", () => {
  const { calls, keyboard } = recorder("field");
  keyboard.keyDown("right-key", false, 1);
  keyboard.keyDown("pause-key", false, 2);
  keyboard.setContext("paused", 5);
  expect(keyboard.keyUp("right-key", 6)).toEqual([]);
  expect(keyboard.keyUp("pause-key", 7)).toEqual(["pause"]);
  keyboard.setContext("field", 8);
  expect(calls).toEqual([
    ["press", "right", 1],
    ["press", "pause", 2],
    ["release", "right", 5],
    ["release", "pause", 7],
  ]);
});

test("a key still down when its action becomes active again is held without a press", () => {
  const { calls, keyboard } = recorder("field");
  keyboard.keyDown("up-key", false, 1);
  keyboard.setContext("paused", 2);
  keyboard.setContext("field", 3);
  expect(keyboard.keyUp("up-key", 4)).toEqual(["up"]);
  expect(calls).toEqual([
    ["press", "up", 1],
    ["release", "up", 2],
    ["resume", "up", 3],
    ["release", "up", 4],
  ]);
});
