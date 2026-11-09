import type { Action, InputContext, UiHandlers } from "./actions.js";
import {
  ACTIONS,
  createActionState,
  toControls,
  withUiHandlers,
} from "./actions.js";
import { VIEW_H, VIEW_W } from "./config.js";
import { createKeyboardSource } from "./keyboard.js";
import type { Point } from "./map.js";
import type { Controls } from "./player.js";

/**
 * Only actions active in the current context respond, and only their keys are kept from
 * the page; every other key keeps its default (focus moves, sliders, typing). UI actions
 * run immediately, outside the simulation step.
 */
export function createInput(
  canvas: HTMLCanvasElement,
  camera: Point,
  uiActions: Partial<Record<Action, UiHandlers>>,
  context: InputContext,
): {
  getControls: (until: number) => Controls;
  mouseWorld: () => Point;
  setContext: (context: InputContext, time: number) => void;
} {
  const state = createActionState();
  const keyboard = createKeyboardSource<Action, InputContext>(
    withUiHandlers(state, uiActions),
    ACTIONS,
    context,
  );
  const mouse = { x: VIEW_W / 2, y: VIEW_H / 2 };
  /** The mouse in world space, through the camera as it currently stands. */
  const mouseWorld = (): Point => ({
    x: mouse.x + camera.x,
    y: mouse.y + camera.y,
  });

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    mouse.y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  });

  window.addEventListener("keydown", (event) => {
    if (keyboard.actionsFor(event.code).length > 0) event.preventDefault();
    keyboard.keyDown(event.code, event.repeat, event.timeStamp);
  });

  window.addEventListener("keyup", (event) => {
    keyboard.keyUp(event.code, event.timeStamp);
  });
  window.addEventListener("blur", (event) => {
    keyboard.blur(event.timeStamp);
  });

  return {
    /**
     * Call once per simulation step with the step's end time (`performance.now()` clock):
     * input up to that time applies, and each press is delivered to exactly one step.
     */
    getControls(until) {
      return toControls(state.consume(until), mouseWorld());
    },
    /** Reads the mouse without consuming input; safe to call from render. */
    mouseWorld,
    /**
     * Makes `context` the active one from `time`: held actions not active in it are
     * released at that time.
     */
    setContext(next, time) {
      keyboard.setContext(next, time);
    },
  };
}
