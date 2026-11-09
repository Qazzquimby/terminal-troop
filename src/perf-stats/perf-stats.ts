import { max, mean, sumBy } from "lodash-es";

const WINDOW_MS = 1000;

/** Timestamped values from the last `windowMs`, oldest first. Callers supply the clock. */
export function createRollingWindow<T>(windowMs = WINDOW_MS) {
  const entries: { time: number; value: T }[] = [];

  function prune(now: number): void {
    while (entries.length > 0 && (entries[0]?.time ?? now) <= now - windowMs)
      entries.shift();
  }

  return {
    push(time: number, value: T): void {
      entries.push({ time, value });
      prune(time);
    },
    values(now: number): T[] {
      prune(now);
      return entries.map((entry) => entry.value);
    },
  };
}

export interface FrameSample {
  /** The frame's timestamp, in ms. */
  readonly now: number;
  /** Fixed simulation steps run this frame. */
  readonly steps: number;
  /** Time spent in the step loop, in ms. */
  readonly updateMs: number;
  /** Time spent drawing, in ms. */
  readonly drawMs: number;
}

export interface PerfSnapshot {
  readonly fps: number;
  readonly frameMsAvg: number;
  readonly frameMsMax: number;
  readonly stepsAvg: number;
  /** Share of frames, 0–1, that ran no simulation step. */
  readonly zeroStepShare: number;
  /** Share of frames, 0–1, that ran two or more simulation steps. */
  readonly multiStepShare: number;
  readonly updateMsAvg: number;
  readonly drawMsAvg: number;
}

interface FrameRecord extends FrameSample {
  /** Time since the previous frame; null for the first frame recorded. */
  readonly frameMs: number | null;
}

/** Rolling ~1s frame statistics. Pure: bootstrap feeds it timestamps. */
export function createPerfStats(windowMs = WINDOW_MS) {
  const frames = createRollingWindow<FrameRecord>(windowMs);
  let previous: number | null = null;

  return {
    recordFrame(sample: FrameSample): void {
      const frameMs = previous === null ? null : sample.now - previous;
      previous = sample.now;
      frames.push(sample.now, { ...sample, frameMs });
    },

    snapshot(now: number): PerfSnapshot {
      const recent = frames.values(now);
      const share = (test: (frame: FrameRecord) => boolean): number =>
        recent.length === 0 ? 0 : recent.filter(test).length / recent.length;
      const frameTimes = recent.flatMap((frame) =>
        frame.frameMs === null ? [] : [frame.frameMs],
      );
      const frameMsAvg = frameTimes.length === 0 ? 0 : mean(frameTimes);
      const average = (pick: (frame: FrameRecord) => number): number =>
        recent.length === 0 ? 0 : sumBy(recent, pick) / recent.length;

      return {
        fps: frameMsAvg === 0 ? 0 : 1000 / frameMsAvg,
        frameMsAvg,
        frameMsMax: max(frameTimes) ?? 0,
        stepsAvg: average((frame) => frame.steps),
        zeroStepShare: share((frame) => frame.steps === 0),
        multiStepShare: share((frame) => frame.steps >= 2),
        updateMsAvg: average((frame) => frame.updateMs),
        drawMsAvg: average((frame) => frame.drawMs),
      };
    },
  };
}
