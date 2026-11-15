/**
 * Calls `held` with true as the pointer goes down on `element`, and with false as it comes up,
 * leaves it, is cancelled, or the window loses focus: for an on-screen button held down, such
 * as a radio's transmit button.
 */
export function whileHeld(
  element: HTMLElement,
  held: (down: boolean) => void,
): void {
  const up = (): void => {
    held(false);
  };
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    held(true);
  });
  element.addEventListener("pointerup", up);
  element.addEventListener("pointerleave", up);
  element.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
}
