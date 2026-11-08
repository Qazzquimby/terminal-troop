import { VIEW_H, VIEW_W } from "./config.js";
import type { Point } from "./map.js";
import type { Controls } from "./player.js";

interface InputActions {
  toggleInventory: () => void;
}

const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);

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
  actions: InputActions,
): { getControls: () => Controls } {
  const keys = new Set<string>();
  const mouse = { x: VIEW_W / 2, y: VIEW_H / 2 };

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    mouse.y = ((event.clientY - rect.top) * canvas.height) / rect.height;
  });

  window.addEventListener("keydown", (event) => {
    if (isTyping(event)) return;

    if (event.code === "Tab") {
      event.preventDefault();
      if (!event.repeat) actions.toggleInventory();
      return;
    }

    if (MOVE_KEYS.has(event.code)) {
      event.preventDefault();
      keys.add(event.code);
    }
  });

  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => {
    keys.clear();
  });

  const held = (...codes: string[]): number =>
    Number(codes.some((code) => keys.has(code)));

  return {
    getControls() {
      let x = held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft");
      let y = held("KeyS", "ArrowDown") - held("KeyW", "ArrowUp");
      const length = Math.hypot(x, y);
      if (length > 0) {
        x /= length;
        y /= length;
      }

      return {
        move: { x, y },
        aim: { x: mouse.x + camera.x, y: mouse.y + camera.y },
      };
    },
  };
}
