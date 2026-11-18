import type { Action, InputContext, UiHandlers } from "./actions.js";
import {
  ACTIONS,
  MOUSE_BUTTONS,
  WHEEL,
  createActionState,
  toControls,
  withUiHandlers,
} from "./actions.js";
import { createButtonSource } from "./buttons.js";
import { createWheelNotches } from "./wheel.js";
import type { WheelConfig } from "./wheel.js";
import { edgePush, turnMovement } from "./turn.js";
import type { TurnConfig } from "./turn.js";
import type { Point, Controls, ViewConfig } from "../sim/index.js";

/**
 * Only actions active in the current context respond, and only their keys are kept from
 * the page; every other key keeps its default (focus moves, sliders, typing). Mouse buttons
 * pressed on the canvas drive actions like keys, and the canvas keeps its context menu to
 * itself while the right button drives an action. Each notch of the wheel over the canvas taps
 * its `WHEEL` key, pressed and released at once, and the page never scrolls under it. UI actions
 * run immediately, outside the simulation step. `toWorld` turns a canvas point into the world
 * point aimed at. Sideways mouse movement is counted up for `takeTurn`, for a view the mouse
 * turns; while capturing, the cursor is hidden over the game and a press on the canvas captures
 * the mouse (pointer lock) so it can turn on without end. Should the browser leave it free, a
 * pointer at the game's side keeps pushing the view round (`edgePush`).
 */
export function createInput(
  canvas: HTMLCanvasElement,
  toWorld: (screen: Point) => Point,
  view: ViewConfig,
  wheel: WheelConfig,
  turnConfig: TurnConfig,
  uiActions: Partial<Record<Action, UiHandlers>>,
  context: InputContext,
): {
  getControls: (until: number) => Controls;
  mouseWorld: () => Point;
  setContext: (context: InputContext, time: number) => void;
  takeTurn: () => number;
  edgePush: () => number;
  setCapture: (on: boolean) => void;
  requestCapture: () => void;
  captured: () => boolean;
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
  /** Sideways mouse movement since `takeTurn` last read it, in CSS pixels. */
  let turn = 0;
  let capture = false;
  /** A free pointer's push on the view at the side of the game, -1 (left) to 1 (right). */
  let push = 0;
  /** Whether a capture asked for is still waiting on the browser. */
  let requesting = false;
  const captured = (): boolean => document.pointerLockElement === canvas;

  /**
   * Captures the mouse, if it is not already. Raw movement is asked for first, unscaled by the
   * system's pointer speed; a browser without it is asked plainly. Refused, the pointer is left
   * free, and the view still turns as it moves, and at the game's sides.
   */
  function requestCapture(): void {
    if (captured() || requesting) return;
    requesting = true;
    const done = () => {
      requesting = false;
    };
    const attempt = (options?: PointerLockOptions): Promise<void> => {
      try {
        return Promise.resolve(canvas.requestPointerLock(options));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error());
      }
    };
    attempt({ unadjustedMovement: true })
      .catch(() => attempt())
      .then(done, done);
  }

  /** The cursor is hidden over the game while the mouse turns the view. */
  function showCursor(): void {
    canvas.classList.toggle("turning", capture);
  }

  // Movement is read from the whole page: a captured pointer's movement goes to the canvas, and a
  // free one that has left the game's side still pushes the view round.
  window.addEventListener("pointermove", (event) => {
    if (capture) turn += turnMovement(event.movementX, turnConfig.spike);
    // A captured pointer stays where it was caught; only its movement counts.
    if (captured()) return;
    const rect = canvas.getBoundingClientRect();
    push = edgePush(event.clientX, rect.left, rect.width, turnConfig.edge.band);
    if (event.target !== canvas) return;
    mouse.x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    mouse.y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  });

  document.addEventListener("pointerlockchange", () => {
    // Caught or freed, the pointer pushes the view no more until it next moves.
    push = 0;
  });
  document.addEventListener("pointerlockerror", () => {
    requesting = false;
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (capture) requestCapture();
    const code = MOUSE_BUTTONS[event.button];
    if (code !== undefined) buttons.keyDown(code, false, event.timeStamp);
  });

  const notches = createWheelNotches(wheel);
  canvas.addEventListener(
    "wheel",
    (event) => {
      // A pinch on a trackpad, or Ctrl and the wheel, zooms the page as ever.
      if (event.ctrlKey) return;
      event.preventDefault();
      const notch = notches.scroll(
        event.deltaY,
        event.deltaMode,
        event.timeStamp,
      );
      if (notch === 0) return;
      const code = notch > 0 ? WHEEL.down : WHEEL.up;
      buttons.keyDown(code, false, event.timeStamp);
      buttons.keyUp(code, event.timeStamp);
    },
    { passive: false },
  );

  canvas.addEventListener("contextmenu", (event) => {
    if (buttons.actionsFor("MouseRight").length > 0) event.preventDefault();
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
    push = 0;
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
    /** Sideways mouse movement since the last call, in CSS pixels: positive to the right. */
    takeTurn() {
      const taken = turn;
      turn = 0;
      return taken;
    },
    /**
     * How hard a free pointer at the game's side pushes the view round, -1 (left) to 1 (right);
     * 0 while the mouse is captured or does not turn the view.
     */
    edgePush() {
      return capture && !captured() ? push : 0;
    },
    /**
     * Whether the mouse turns the view: a press on the canvas captures it, and the cursor is
     * hidden over the game. Turning it off frees a captured one.
     */
    setCapture(on) {
      if (on === capture) return;
      capture = on;
      showCursor();
      if (!on && captured()) document.exitPointerLock();
    },
    /** Captures the mouse now; for a press or key outside the canvas, such as closing settings. */
    requestCapture,
    /** Whether the mouse is captured. */
    captured,
  };
}
