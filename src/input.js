import { PlayerClass } from "./classes/index.js";
import { VIEW_H, VIEW_W } from "./config.js";

const CLASS_ORDER = Object.values(PlayerClass);
const PRIMARY_BUTTON_MASK = 1;
const SECONDARY_BUTTON_MASK = 2;
const SECONDARY_KEY = "Space";
const BUTTON_EVENTS = Object.freeze([
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointerrawupdate",
  "mousedown",
  "mousemove",
  "mouseup",
]);

export function createInput(canvas, camera, actions) {
  const keys = new Set();
  const mouse = { x: VIEW_W / 2, y: VIEW_H / 2 };
  const aim = { x: 0, y: 0 };
  const move = { x: 0, y: 0 };
  let heldButtons = 0;
  let pressedButtons = 0;
  const controls = {
    move,
    aim,
    primary: false,
    secondary: false,
    primaryPressed: false,
    secondaryPressed: false,
  };

  function isTyping(event) {
    const target = event.target;
    return (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    );
  }

  function updateMouse(event) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = (event.clientX - rect.left) * (canvas.width / rect.width);
    mouse.y = (event.clientY - rect.top) * (canvas.height / rect.height);
  }

  function recordButtons(event) {
    pressedButtons |= event.buttons & ~heldButtons;
    heldButtons = event.buttons;
  }

  canvas.addEventListener("mousemove", updateMouse);
  for (const eventType of BUTTON_EVENTS) {
    window.addEventListener(eventType, recordButtons);
  }

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  canvas.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  window.addEventListener("pointerup", recordButtons);

  window.addEventListener("keydown", (event) => {
    if (isTyping(event)) return;
    keys.add(event.code);
    if (event.code === SECONDARY_KEY) event.preventDefault();
    if (event.repeat) return;

    if (event.code === SECONDARY_KEY) {
      pressedButtons |= SECONDARY_BUTTON_MASK;
    }
    if (event.code.startsWith("Digit")) {
      const index = Number(event.code.slice(5)) - 1;
      if (index >= 0 && index < CLASS_ORDER.length) actions.selectClass(CLASS_ORDER[index]);
    } else if (event.code === "KeyB") {
      actions.toggleDummy();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === SECONDARY_KEY && !isTyping(event)) event.preventDefault();
    keys.delete(event.code);
  });

  window.addEventListener("blur", () => {
    keys.clear();
    heldButtons = 0;
    pressedButtons = 0;
  });

  function getControls() {
    let x = 0;
    let y = 0;
    if (keys.has("KeyA")) x -= 1;
    if (keys.has("KeyD")) x += 1;
    if (keys.has("KeyW")) y -= 1;
    if (keys.has("KeyS")) y += 1;
    const length = Math.hypot(x, y);
    if (length > 0) {
      x /= length;
      y /= length;
    }
    move.x = x;
    move.y = y;
    aim.x = mouse.x + camera.x;
    aim.y = mouse.y + camera.y;
    controls.primary = Boolean(heldButtons & PRIMARY_BUTTON_MASK);
    controls.secondary =
      Boolean(heldButtons & SECONDARY_BUTTON_MASK) || keys.has(SECONDARY_KEY);
    controls.primaryPressed = Boolean(pressedButtons & PRIMARY_BUTTON_MASK);
    controls.secondaryPressed = Boolean(pressedButtons & SECONDARY_BUTTON_MASK);
    pressedButtons = 0;
    return controls;
  }

  return { getControls };
}
