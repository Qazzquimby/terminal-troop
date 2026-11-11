import type { Action, InputContext, UiHandlers } from "./actions.js";
import {
  ACTIONS,
  MOUSE_BUTTONS,
  createActionState,
  toControls,
  withUiHandlers,
} from "./actions.js";
import { createButtonSource } from "./buttons.js";
import type { Point, Controls, ViewConfig } from "../sim/index.js";

/**
 * Only actions active in the current context respond, and only their keys are kept from
 * the page; every other key keeps its default (focus moves, sliders, typing). Mouse buttons
 * pressed on the canvas drive actions like keys. UI actions run immediately, outside the
 * simulation step. `toWorld` turns a canvas point into a world point.
 */
export function createInput(
  canvas: HTMLCanvasElement,
  toWorld: (screen: Point) => Point,
  view: ViewConfig,
  uiActions: Partial<Record<Action, UiHandlers>>,
  context: InputContext,
): {
  getControls: (until: number) => Controls;
  mouseWorld: () => Point;
  setContext: (context: InputContext, time: number) => void;
} {
  const state = createActionState();
  const buttons = createButtonSource<Action, InputContext>(
    withUiHandlers(state, uiActions),
    ACTIONS,
    context,
  );
  const mouse = { x: view.width / 2, y: view.height / 2 };
  /** The mouse in world space, as `toWorld` currently maps it. */
  const mouseWorld = (): Point => toWorld(mouse);

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    mouse.y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  });

  canvas.addEventListener("pointerdown", (event) => {
    const code = MOUSE_BUTTONS[event.button];
    if (code !== undefined) buttons.keyDown(code, false, event.timeStamp);
  });

  window.addEventListener("pointerup", (event) => {
    const code = MOUSE_BUTTONS[event.button];
    if (code !== undefined) buttons.keyUp(code, event.timeStamp);
  });

  window.addEventListener("keydown", (event) => {
    if (buttons.actionsFor(event.code).length > 0) event.preventDefault();
    buttons.keyDown(event.code, event.repeat, event.timeStamp);
  });

  window.addEventListener("keyup", (event) => {
    buttons.keyUp(event.code, event.timeStamp);
  });
  window.addEventListener("blur", (event) => {
    buttons.blur(event.timeStamp);
  });

  return {
    /**
     * The controls for one simulation step, given the step's end time (`performance.now()`
     * clock): input up to that time applies, and each press is delivered to exactly one step.
     */
    getControls: (until) => toControls(state.consume(until), mouseWorld()),
    /** Reads the mouse without consuming input; safe to call from render. */
    mouseWorld,
    /**
     * Makes `context` the active one from `time`: held actions not active in it are
     * released at that time.
     */
    setContext(next, time) {
      buttons.setContext(next, time);
    },
  };
}
