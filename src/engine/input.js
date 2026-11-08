import { VIEW_H, VIEW_W } from "./config.js";

export function createInput(canvas, camera, actions) {
  const keys = new Set();
  const mouse = { x: VIEW_W / 2, y: VIEW_H / 2 };

  function isTyping(event) {
    return event.target instanceof HTMLElement && (
      event.target.matches("input, textarea, select") ||
      event.target.isContentEditable
    );
  }

  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    mouse.x = (event.clientX - rect.left) * canvas.width / rect.width;
    mouse.y = (event.clientY - rect.top) * canvas.height / rect.height;
  });

  window.addEventListener("keydown", (event) => {
    if (isTyping(event)) return;

    if (event.code === "Tab") {
      event.preventDefault();
      if (!event.repeat) actions.toggleInventory();
      return;
    }

    if (
      ["KeyW", "KeyA", "KeyS", "KeyD",
        "ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.code)
    ) {
      event.preventDefault();
      keys.add(event.code);
    }
  });

  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => keys.clear());

  return {
    getControls() {
      let x = Number(keys.has("KeyD") || keys.has("ArrowRight"))
        - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
      let y = Number(keys.has("KeyS") || keys.has("ArrowDown"))
        - Number(keys.has("KeyW") || keys.has("ArrowUp"));
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
