type Disposer = () => void | Promise<void>;

/**
 * Owns cleanup for something with a lifetime. Disposers run in reverse order of registration,
 * each awaited before the next.
 */
export interface Scope {
  /** Aborted at the start of `dispose()`; pass it to `addEventListener` and `fetch`. */
  readonly signal: AbortSignal;
  readonly disposed: boolean;
  /** Registers `fn` to run on dispose; runs it at once if the scope is already disposed. */
  defer(fn: Disposer): void;
  /** Registers `dispose(value)` like `defer`, and returns `value`. */
  adopt<T>(value: T, dispose: (value: T) => void | Promise<void>): T;
  /** A scope disposed with this one; disposing it first detaches it. */
  child(): Scope;
  /**
   * Runs every disposer even when some throw, then rejects with the single error or an
   * `AggregateError`. Later calls return the same promise.
   */
  dispose(): Promise<void>;
}

async function runAll(disposers: readonly Disposer[]): Promise<void> {
  const errors: unknown[] = [];
  for (const fn of disposers) {
    try {
      await fn();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Scope disposal failed");
}

export function createScope(): Scope {
  const controller = new AbortController();
  const disposers: Disposer[] = [];
  let done: Promise<void> | null = null;

  const scope: Scope = {
    signal: controller.signal,
    get disposed() {
      return done !== null;
    },
    defer(fn) {
      if (done === null) {
        disposers.push(fn);
        return;
      }
      void runAll([fn]).catch((error: unknown) => {
        console.warn("Disposer failed after scope disposal", error);
      });
    },
    adopt(value, dispose) {
      scope.defer(() => dispose(value));
      return value;
    },
    child() {
      const inner = createScope();
      const disposeInner: Disposer = () => inner.dispose();
      scope.defer(disposeInner);
      inner.defer(() => {
        const index = disposers.indexOf(disposeInner);
        if (index !== -1) disposers.splice(index, 1);
      });
      return inner;
    },
    dispose() {
      if (done === null) {
        controller.abort();
        done = runAll(disposers.splice(0).reverse());
      }
      return done;
    },
  };
  return scope;
}
