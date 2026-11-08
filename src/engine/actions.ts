import type { Point } from "./map.js";
import type { Controls } from "./player.js";

/** The only place key codes are named. */
const BINDINGS = {
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

function keysOf<T extends object>(object: T): Extract<keyof T, string>[] {
  const keys: Extract<keyof T, string>[] = [];
  for (const key in object) keys.push(key);
  return keys;
}

const ACTIONS = keysOf(BINDINGS);

export function actionsFor(code: string): Action[] {
  return ACTIONS.filter((action) =>
    BINDINGS[action].some((bound) => bound === code),
  );
}

export function createActionState() {
  const keys = new Set<string>();
  const pressed = new Set<Action>();
  const released = new Set<Action>();
  const isHeld = (action: Action): boolean =>
    BINDINGS[action].some((code) => keys.has(code));

  return {
    /**
     * Returns the actions this key newly pressed (edge-triggered). A repeat only
     * restores a key still held after blur: it is held again but not pressed.
     */
    keyDown(code: string, repeat: boolean): Action[] {
      if (keys.has(code)) return [];
      if (repeat) {
        keys.add(code);
        return [];
      }
      const fresh = actionsFor(code).filter((action) => !isHeld(action));
      keys.add(code);
      for (const action of fresh) pressed.add(action);
      return fresh;
    },
    /** An action is released only when its last held key goes up. */
    keyUp(code: string): void {
      if (!keys.delete(code)) return;
      for (const action of actionsFor(code)) {
        if (!isHeld(action)) released.add(action);
      }
    },
    /** Blur: drops held keys and pending presses; every held action counts as released. */
    clear(): void {
      for (const action of ACTIONS.filter(isHeld)) released.add(action);
      keys.clear();
      pressed.clear();
    },
    /** Snapshot for one simulation step; clears the pressed and released sets. */
    consume(): ActionFrame {
      const frame = {
        held: new Set(ACTIONS.filter(isHeld)),
        pressed: new Set(pressed),
        released: new Set(released),
      };
      pressed.clear();
      released.clear();
      return frame;
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
