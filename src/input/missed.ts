import { MOUSE_BUTTONS } from "./actions.js";

/** What a pointer event says is down as it happens. */
export interface PointerHeld {
  /** `MouseEvent.buttons`: a bit for each button down. */
  readonly buttons: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** The `MouseEvent.buttons` bit of each `MouseEvent.button`, in `MOUSE_BUTTONS` order. */
const BUTTON_BITS = [1, 4, 2];

/** Each modifier key's codes, by the flag a pointer event carries for it. */
const MODIFIERS: readonly [keyof PointerHeld, readonly string[]][] = [
  ["shiftKey", ["ShiftLeft", "ShiftRight"]],
  ["ctrlKey", ["ControlLeft", "ControlRight"]],
  ["altKey", ["AltLeft", "AltRight"]],
  ["metaKey", ["MetaLeft", "MetaRight"]],
];

/**
 * The key codes `event` shows are up: each mouse button whose bit is clear, and each modifier
 * whose flag is. Releasing them catches a release the page never heard, as when the browser's own
 * context menu takes the right button's release, which Firefox opens on Shift and a right click
 * whatever the page asks (`dom.event.contextmenu.shift_suppresses_event`).
 */
export function upKeys(event: PointerHeld): string[] {
  const up: string[] = [];
  MOUSE_BUTTONS.forEach((code, button) => {
    const bit = BUTTON_BITS[button] ?? 0;
    if ((event.buttons & bit) === 0) up.push(code);
  });
  for (const [flag, codes] of MODIFIERS)
    if (event[flag] === false) up.push(...codes);
  return up;
}
