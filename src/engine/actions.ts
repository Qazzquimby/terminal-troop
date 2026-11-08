import type { Point } from "./map.js";
import type { Controls } from "./player.js";

/** The only place key codes are named. */
export const BINDINGS = {
  moveUp: ["KeyW", "ArrowUp"],
  moveLeft: ["KeyA", "ArrowLeft"],
  moveDown: ["KeyS", "ArrowDown"],
  moveRight: ["KeyD", "ArrowRight"],
  sprint: ["ShiftLeft", "ShiftRight"],
  toggleInventory: ["Tab"],
  toggleDebug: ["F3"],
} as const;

export type Action = keyof typeof BINDINGS;

/** What one simulation step sees: held actions, and actions pressed or released since the previous step. */
export interface ActionFrame {
  readonly held: ReadonlySet<Action>;
  readonly pressed: ReadonlySet<Action>;
  readonly released: ReadonlySet<Action>;
}

/**
 * What a source of actions (keyboard, gamepad, touch, a script) drives. Every
 * event carries its time in ms on the `performance.now()` clock.
 */
export interface ActionSink {
  /** Edge-triggered: pressing an action that is already held does nothing. */
  press(action: Action, time: number): void;
  /** Releases a held action; does nothing if it was not held. */
  release(action: Action, time: number): void;
  /** Holds an action again without counting it as pressed, e.g. after blur. */
  resume(action: Action, time: number): void;
  /** Blur: every held action counts as released and pending presses are dropped. */
  clear(time: number): void;
}

type ActionEvent =
  | {
      readonly kind: "press" | "release" | "resume";
      readonly action: Action;
      readonly time: number;
    }
  | { readonly kind: "clear"; readonly time: number };

export function createActionState(): ActionSink & {
  consume(until: number): ActionFrame;
} {
  let queue: ActionEvent[] = [];
  const held = new Set<Action>();
  const pressed = new Set<Action>();
  const released = new Set<Action>();

  const apply = (event: ActionEvent): void => {
    if (event.kind === "clear") {
      for (const action of held) released.add(action);
      held.clear();
      pressed.clear();
      return;
    }
    const { action } = event;
    if (event.kind === "release") {
      if (held.delete(action)) released.add(action);
      return;
    }
    if (held.has(action)) return;
    held.add(action);
    if (event.kind === "press") pressed.add(action);
  };

  return {
    press(action, time) {
      queue.push({ kind: "press", action, time });
    },
    release(action, time) {
      queue.push({ kind: "release", action, time });
    },
    resume(action, time) {
      queue.push({ kind: "resume", action, time });
    },
    clear(time) {
      queue.push({ kind: "clear", time });
    },
    /**
     * The frame for one simulation step ending at `until`: applies queued events
     * up to that time in time order, and leaves later ones for a later step.
     */
    consume(until) {
      const due = queue
        .filter((event) => event.time <= until)
        .sort((a, b) => a.time - b.time);
      queue = queue.filter((event) => event.time > until);
      pressed.clear();
      released.clear();
      for (const event of due) apply(event);
      return {
        held: new Set(held),
        pressed: new Set(pressed),
        released: new Set(released),
      };
    },
  };
}

export function toControls(frame: ActionFrame, aim: Point): Controls {
  const axis = (negative: Action, positive: Action): number =>
    Number(frame.held.has(positive)) - Number(frame.held.has(negative));
  const x = axis("moveLeft", "moveRight");
  const y = axis("moveUp", "moveDown");
  const length = Math.max(Math.hypot(x, y), 1);
  return {
    move: { x: x / length, y: y / length },
    aim,
    sprint: frame.held.has("sprint"),
  };
}
