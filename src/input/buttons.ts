import type { ActionSink } from "./actions.js";
import { activeIn } from "./actions.js";

/** An action's keys, and the contexts in which it is active. */
interface Binding<C extends string> {
  readonly keys: readonly string[];
  readonly contexts: readonly C[];
}

function keysOf<T extends object>(object: T): Extract<keyof T, string>[] {
  const keys: Extract<keyof T, string>[] = [];
  for (const key in object) keys.push(key);
  return keys;
}

/**
 * Turns key and mouse button events into actions on `sink`. Pure and DOM-free: the caller
 * feeds it key codes, a mouse button's being its `MOUSE_BUTTONS` name, and the current context.
 * An action is held while it is active in the context and any of its keys is down; only active
 * actions reach the sink.
 */
export function createButtonSource<A extends string, C extends string>(
  sink: ActionSink<A>,
  bindings: Readonly<Record<A, Binding<C>>>,
  initialContext: C,
) {
  const keys = new Set<string>();
  let context = initialContext;
  const all = keysOf(bindings);
  const isActive = (action: A): boolean => activeIn(bindings[action], context);
  const isHeld = (action: A): boolean =>
    isActive(action) && bindings[action].keys.some((code) => keys.has(code));
  const heldActions = (): Set<A> => new Set(all.filter(isHeld));
  const actionsFor = (code: string): A[] =>
    all.filter(
      (action) => isActive(action) && bindings[action].keys.includes(code),
    );

  return {
    /** The actions a key drives in the current context; empty if it drives none. */
    actionsFor,
    /**
     * Returns the actions this key newly pressed. Repeats never press: a repeat
     * only restores a key still held after blur, holding its actions again.
     */
    keyDown(code: string, repeat: boolean, time: number): A[] {
      if (keys.has(code)) return [];
      const fresh = actionsFor(code).filter((action) => !isHeld(action));
      keys.add(code);
      if (repeat) {
        for (const action of fresh) sink.resume(action, time);
        return [];
      }
      for (const action of fresh) sink.press(action, time);
      return fresh;
    },
    /** Returns the actions released: those whose last held key this was. */
    keyUp(code: string, time: number): A[] {
      const before = actionsFor(code).filter(isHeld);
      if (!keys.delete(code)) return [];
      const freed = before.filter((action) => !isHeld(action));
      for (const action of freed) sink.release(action, time);
      return freed;
    },
    /** Window blur: releases every held action, forgets every key and clears the sink. */
    blur(time: number): void {
      for (const action of heldActions()) sink.release(action, time);
      keys.clear();
      sink.clear(time);
    },
    /**
     * Switches context at `time`: held actions not active in the new context are
     * released, and actions it activates whose keys are already down are held
     * again without a press.
     */
    setContext(next: C, time: number): void {
      const before = heldActions();
      context = next;
      const after = heldActions();
      for (const action of before)
        if (!after.has(action)) sink.release(action, time);
      for (const action of after)
        if (!before.has(action)) sink.resume(action, time);
    },
  };
}
