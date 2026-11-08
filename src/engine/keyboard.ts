import type { Action, ActionSink } from "./actions.js";
import { BINDINGS } from "./actions.js";

/** Key codes bound to each action; an action may have several keys or none. */
type Bindings = Partial<Record<Action, readonly string[]>>;

function keysOf<T extends object>(object: T): Extract<keyof T, string>[] {
  const keys: Extract<keyof T, string>[] = [];
  for (const key in object) keys.push(key);
  return keys;
}

/**
 * Turns key events into actions on `sink`. Pure and DOM-free: the caller feeds
 * it key codes. An action is held while any of its keys is down.
 */
export function createKeyboardSource(
  sink: ActionSink,
  bindings: Bindings = BINDINGS,
) {
  const keys = new Set<string>();
  const bound = keysOf(bindings);
  const codesFor = (action: Action): readonly string[] =>
    bindings[action] ?? [];
  const isHeld = (action: Action): boolean =>
    codesFor(action).some((code) => keys.has(code));
  const actionsFor = (code: string): Action[] =>
    bound.filter((action) => codesFor(action).includes(code));

  return {
    /** The actions bound to a key; empty for an unbound key. */
    actionsFor,
    /**
     * Returns the actions this key newly pressed. Repeats never press: a repeat
     * only restores a key still held after blur, holding its actions again.
     */
    keyDown(code: string, repeat: boolean, time: number): Action[] {
      if (keys.has(code)) return [];
      if (repeat) {
        keys.add(code);
        for (const action of actionsFor(code)) sink.resume(action, time);
        return [];
      }
      const fresh = actionsFor(code).filter((action) => !isHeld(action));
      keys.add(code);
      for (const action of fresh) sink.press(action, time);
      return fresh;
    },
    /** Returns the actions released: those whose last held key this was. */
    keyUp(code: string, time: number): Action[] {
      if (!keys.delete(code)) return [];
      const freed = actionsFor(code).filter((action) => !isHeld(action));
      for (const action of freed) sink.release(action, time);
      return freed;
    },
    /** Window blur: forgets every key and clears the sink. */
    blur(time: number): void {
      keys.clear();
      sink.clear(time);
    },
  };
}
