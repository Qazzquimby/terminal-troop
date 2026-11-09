import type { Point, Controls } from "../sim/index.js";

/**
 * The only place key codes and context permissions are named: each action's keys,
 * and the input contexts it is active in.
 */
export const ACTIONS = {
  moveUp: { keys: ["KeyW", "ArrowUp"], contexts: ["play"] },
  moveLeft: { keys: ["KeyA", "ArrowLeft"], contexts: ["play"] },
  moveDown: { keys: ["KeyS", "ArrowDown"], contexts: ["play"] },
  moveRight: { keys: ["KeyD", "ArrowRight"], contexts: ["play"] },
  sprint: { keys: ["ShiftLeft", "ShiftRight"], contexts: ["play"] },
  toggleInventory: { keys: ["Tab"], contexts: ["play"] },
  toggleSettings: { keys: ["Escape"], contexts: ["play", "menu"] },
  toggleDebug: { keys: ["F3"], contexts: ["play", "menu"] },
  pushToTalk: { keys: ["KeyV"], contexts: ["play", "menu"] },
} as const;

export type Action = keyof typeof ACTIONS;

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Escape: "Esc",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Display text for a `KeyboardEvent.code`; an unknown code is shown as itself. */
export function keyLabel(code: string): string {
  const named = NAMED_KEYS[code];
  if (named !== undefined) return named;
  const match = /^(?:Key|Digit)(.)$/.exec(code);
  return match?.[1] ?? code;
}

/** Display text for the first key bound to `action`. */
export function actionKeyLabel(action: Action): string {
  return keyLabel(ACTIONS[action].keys[0]);
}

/**
 * What input is for right now: the contexts named in `ACTIONS` (`play`, `menu`),
 * plus `text`, focus in a text field, where no action is active.
 */
export type InputContext =
  (typeof ACTIONS)[Action]["contexts"][number] | "text";

/** Whether a binding with these contexts is active in `context`. */
export function activeIn<C extends string>(
  binding: { readonly contexts: readonly C[] },
  context: C,
): boolean {
  return binding.contexts.includes(context);
}

/** Whether `action` is active in `context`. */
export function isActiveIn(action: Action, context: InputContext): boolean {
  return activeIn<InputContext>(ACTIONS[action], context);
}

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
export interface ActionSink<A extends string = Action> {
  /** Edge-triggered: pressing an action that is already held does nothing. */
  press(action: A, time: number): void;
  /** Releases a held action; does nothing if it was not held. */
  release(action: A, time: number): void;
  /** Holds an action again without counting it as pressed, e.g. after blur or a context switch. */
  resume(action: A, time: number): void;
  /** Blur: every held action counts as released and pending presses are dropped. */
  clear(time: number): void;
}

/** What a UI action does, run at once with the event time. */
export interface UiHandlers {
  /** Runs on a press of an action that is not held; never on resume. */
  press?: (time: number) => void;
  /** Runs whenever the action starts or stops being held, whatever the cause. */
  held?: (held: boolean, time: number) => void;
}

/**
 * Passes every event on to `sink`, runs `press` handlers on presses, and runs
 * `held` handlers on each change of an action's held state.
 */
export function withUiHandlers<A extends string>(
  sink: ActionSink<A>,
  handlers: Partial<Record<A, UiHandlers>>,
): ActionSink<A> {
  const held = new Set<A>();
  const hold = (action: A, time: number): void => {
    if (held.has(action)) return;
    held.add(action);
    handlers[action]?.held?.(true, time);
  };
  const letGo = (action: A, time: number): void => {
    if (!held.delete(action)) return;
    handlers[action]?.held?.(false, time);
  };
  return {
    press(action, time) {
      sink.press(action, time);
      if (held.has(action)) return;
      handlers[action]?.press?.(time);
      hold(action, time);
    },
    release(action, time) {
      sink.release(action, time);
      letGo(action, time);
    },
    resume(action, time) {
      sink.resume(action, time);
      hold(action, time);
    },
    clear(time) {
      sink.clear(time);
      for (const action of [...held]) letGo(action, time);
    },
  };
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
