import { describe, expect, test, vi } from "vitest";
import { createScope } from "./scope.js";

describe("dispose", () => {
  test("runs disposers in reverse order of registration", async () => {
    const scope = createScope();
    const ran: string[] = [];
    scope.defer(() => {
      ran.push("first");
    });
    scope.adopt("second", (value) => {
      ran.push(value);
    });
    scope.defer(() => {
      ran.push("third");
    });
    await scope.dispose();
    expect(ran).toEqual(["third", "second", "first"]);
  });

  test("awaits each async disposer before starting the next", async () => {
    const scope = createScope();
    const ran: string[] = [];
    scope.defer(() => {
      ran.push("sync");
    });
    scope.defer(async () => {
      ran.push("async start");
      await new Promise((resolve) => setTimeout(resolve, 5));
      ran.push("async end");
    });
    await scope.dispose();
    expect(ran).toEqual(["async start", "async end", "sync"]);
  });

  test("adopt returns the value it was given", () => {
    const scope = createScope();
    const value = { id: 1 };
    expect(scope.adopt(value, () => undefined)).toBe(value);
  });

  test("a throwing disposer rejects with its error after the rest run", async () => {
    const scope = createScope();
    const ran: string[] = [];
    const failure = new Error("boom");
    scope.defer(() => {
      ran.push("first");
    });
    scope.defer(() => {
      throw failure;
    });
    await expect(scope.dispose()).rejects.toBe(failure);
    expect(ran).toEqual(["first"]);
  });

  test("several failures reject with an AggregateError of all of them", async () => {
    const scope = createScope();
    const first = new Error("first");
    const second = new Error("second");
    scope.defer(() => {
      throw first;
    });
    scope.defer(() => Promise.reject(second));
    const result = scope.dispose();
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await result.catch((error: unknown) => {
      expect(error instanceof AggregateError ? error.errors : []).toEqual([
        second,
        first,
      ]);
    });
  });

  test("is idempotent: a second call returns the same promise and runs nothing again", async () => {
    const scope = createScope();
    const fn = vi.fn();
    scope.defer(fn);
    const once = scope.dispose();
    expect(scope.dispose()).toBe(once);
    await once;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scope.disposed).toBe(true);
  });

  test("aborts the signal before any disposer runs", async () => {
    const scope = createScope();
    let abortedDuringDisposer: boolean | null = null;
    scope.defer(() => {
      abortedDuringDisposer = scope.signal.aborted;
    });
    expect(scope.signal.aborted).toBe(false);
    expect(scope.disposed).toBe(false);
    await scope.dispose();
    expect(abortedDuringDisposer).toBe(true);
  });

  test("the signal removes listeners added with it", async () => {
    const scope = createScope();
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener("ping", heard, { signal: scope.signal });
    target.dispatchEvent(new Event("ping"));
    await scope.dispose();
    target.dispatchEvent(new Event("ping"));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("after dispose", () => {
  test("defer runs the disposer immediately", async () => {
    const scope = createScope();
    await scope.dispose();
    const fn = vi.fn();
    scope.defer(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("adopt disposes the value immediately and still returns it", async () => {
    const scope = createScope();
    await scope.dispose();
    const disposed: string[] = [];
    expect(
      scope.adopt("late", (value) => {
        disposed.push(value);
      }),
    ).toBe("late");
    expect(disposed).toEqual(["late"]);
  });
});

describe("child", () => {
  test("is disposed with its parent, in registration order", async () => {
    const parent = createScope();
    const ran: string[] = [];
    parent.defer(() => {
      ran.push("parent first");
    });
    const child = parent.child();
    child.defer(() => {
      ran.push("child");
    });
    parent.defer(() => {
      ran.push("parent last");
    });
    await parent.dispose();
    expect(ran).toEqual(["parent last", "child", "parent first"]);
    expect(child.disposed).toBe(true);
    expect(child.signal.aborted).toBe(true);
  });

  test("disposed early detaches from its parent", async () => {
    const parent = createScope();
    const child = parent.child();
    const failure = new Error("child failed");
    child.defer(() => {
      throw failure;
    });
    await expect(child.dispose()).rejects.toBe(failure);
    await expect(parent.dispose()).resolves.toBeUndefined();
  });

  test("a child's failure surfaces from the parent's dispose", async () => {
    const parent = createScope();
    const failure = new Error("child failed");
    parent.child().defer(() => {
      throw failure;
    });
    await expect(parent.dispose()).rejects.toBe(failure);
  });
});
