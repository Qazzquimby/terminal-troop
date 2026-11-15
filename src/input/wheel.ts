/** How scrolling the mouse wheel or a trackpad turns into notches. */
export interface WheelConfig {
  /** Pixels of scroll that make one notch. */
  readonly notch: number;
  /** Pixels one line of scroll counts as, for wheels that report lines. */
  readonly line: number;
  /** Pixels one page of scroll counts as, for wheels that report pages. */
  readonly page: number;
  /** Ms without scrolling after which a part-notch is forgotten. */
  readonly idleMs: number;
}

/** `WheelEvent.deltaMode`: pixels, lines or pages. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Counts scroll into notches, so that one click of a wheel, or a trackpad swipe of `notch` pixels,
 * is one notch however finely the device reports it. Each event gives at most one notch: a wheel
 * that reports a click as one big delta still moves one. Scroll that turns the other way, or comes
 * after `idleMs` of none, starts counting afresh. Pure and DOM-free.
 */
export function createWheelNotches(config: WheelConfig) {
  let sum = 0;
  let last = -Infinity;
  return {
    /**
     * Adds one wheel event's vertical scroll: +1 for a notch down (towards the page's end), -1
     * for a notch up, 0 for none yet.
     */
    scroll(deltaY: number, deltaMode: number, time: number): -1 | 0 | 1 {
      const scale =
        deltaMode === DOM_DELTA_LINE
          ? config.line
          : deltaMode === DOM_DELTA_PAGE
            ? config.page
            : 1;
      const pixels = deltaY * scale;
      if (pixels === 0) return 0;
      if (time - last > config.idleMs || Math.sign(pixels) !== Math.sign(sum))
        sum = 0;
      last = time;
      sum += pixels;
      if (Math.abs(sum) < config.notch) return 0;
      const notch = sum > 0 ? 1 : -1;
      sum = 0;
      return notch;
    },
  };
}
