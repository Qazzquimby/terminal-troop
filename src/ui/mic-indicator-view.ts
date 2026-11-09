import type { MicIndicator } from "../voice/index.js";

/** Renders indicators into `element`, touching the DOM only when the shown state changes. */
export function createMicIndicatorView(element: HTMLElement) {
  let shown: MicIndicator | null = null;
  element.hidden = true;

  return {
    /** Null hides the indicator. */
    show(next: MicIndicator | null): void {
      if (next?.label === shown?.label && next?.tone === shown?.tone) return;
      shown = next;
      element.hidden = next === null;
      if (next === null) return;
      element.textContent = next.label;
      element.dataset.tone = next.tone;
    },
  };
}
