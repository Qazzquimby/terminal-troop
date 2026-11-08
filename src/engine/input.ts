import type { Action } from "./actions.js";
import { actionsFor, createActionState, toControls } from "./actions.js";
import { VIEW_H, VIEW_W } from "./config.js";
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
): { getControls: () => Controls; mouseWorld: () => Point } {
  const state = createActionState();
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
    if (isTyping(event) || actionsFor(event.code).length === 0) return;
    event.preventDefault();
    for (const action of state.keyDown(event.code, event.repeat)) {
      uiActions[action]?.();
    }
  });

  window.addEventListener("keyup", (event) => {
    state.keyUp(event.code);
  });
  window.addEventListener("blur", () => {
    state.clear();
  });

  return {
    /** Call once per simulation step: pressed actions are delivered to exactly one step. */
    getControls() {
      return toControls(state.consume(), mouseWorld());
    },
    /** Reads the mouse without consuming input; safe to call from render. */
    mouseWorld,
  };
}
