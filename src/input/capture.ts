/**
 * What the mouse does over the game:
 * - free: the browser's own cursor, for clicking on a page or a menu
 * - turn: captured, it turns the view, as with the rotating camera
 * - point: captured, it moves a cursor the game draws, aiming as the browser's cursor would; the
 *   browser then opens no menu of its own on the game, such as Firefox's on Shift and a right
 *   click (#496)
 *
 * Captured means pointer lock, which the browser may refuse; refused, the browser's cursor works
 * as ever.
 */
export type CaptureMode = "free" | "turn" | "point";

/** What decides how the mouse is captured. */
export interface CaptureState {
  /** In a room, with a world to play in. */
  readonly playing: boolean;
  /** A page or menu over the game wants the pointer: settings, the spawn menu, a vehicle's cabin. */
  readonly ui: boolean;
  /** The mouse turns the view, as the rotating camera has it. */
  readonly turning: boolean;
}

/** How the mouse is captured for `state`. */
export function captureMode(state: CaptureState): CaptureMode {
  if (!state.playing || state.ui) return "free";
  return state.turning ? "turn" : "point";
}

/** What capturing needs of the input. */
export interface Capturer {
  setCapture: (mode: CaptureMode) => void;
  /** Gives the game the keyboard's focus and asks to capture the mouse. */
  reclaim: () => void;
}

/**
 * Keeps `input` captured as `sync` is told, and gives the game focus back, and the mouse with it,
 * whenever the mouse goes from free to captured: on leaving a menu or a vehicle, or on coming into
 * a room. Browsers capture the mouse only soon after a press or a click, so `sync` is best called
 * in the handler of the press that closed the menu; called from the next frame instead, the press
 * is still recent enough for most. A mouse freed by the player while it stays wanted, as with
 * Escape, is not caught again until the next click on the game.
 */
export function createCaptureControl(input: Capturer) {
  let mode: CaptureMode = "free";
  return {
    sync(next: CaptureMode): void {
      const was = mode;
      mode = next;
      input.setCapture(next);
      if (was === "free" && next !== "free") input.reclaim();
    },
    mode: (): CaptureMode => mode,
  };
}
