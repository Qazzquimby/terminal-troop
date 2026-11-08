import type { Action } from "./actions.js";
import { createActionState, toControls } from "./actions.js";
import { VIEW_H, VIEW_W } from "./config.js";
import { createKeyboardSource } from "./keyboard.js";
import type { Point } from "./map.js";
import type { Controls } from "./player.js";

/** UI actions fire immediately on press, outside the simulation step. */
type UiActions = Partial<Record<Action, () => void>>;

function isTyping(event: KeyboardEvent): boolean {
  return (
    event.target instanceof HTMLElement &&
    (event.target.matches("input, textarea, select") ||
      event.target.isContentEditable)
  );
}

export function createInput(
  canvas: HTMLCanvasElement,
  camera: Point,
  uiActions: UiActions,
): {
  getControls: (until: number) => Controls;
  mouseWorld: () => Point;
} {
  const state = createActionState();
  const keyboard = createKeyboardSource(state);
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
    if (isTyping(event) || keyboard.actionsFor(event.code).length === 0) {
      return;
    }
    event.preventDefault();
    for (const action of keyboard.keyDown(
      event.code,
      event.repeat,
      event.timeStamp,
    )) {
      uiActions[action]?.();
    }
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
  };
}
