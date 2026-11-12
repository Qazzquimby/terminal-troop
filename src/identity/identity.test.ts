import { describe, expect, test } from "vitest";
import { createPlayerIdentity } from "./identity.js";
import type { PlayerIdStorage } from "./identity.js";

/** A page's storage, held in a variable. */
function pageStorage(): PlayerIdStorage & { value: string | null } {
  return {
    value: null,
    get() {
      return this.value;
    },
    set(value) {
      this.value = value;
    },
  };
}

/** Ids "id-1", "id-2", … in turn. */
function counter(): () => string {
  let n = 0;
  return () => `id-${String(++n)}`;
}

describe("player identity", () => {
  test("keeps its id across a reload of the page", () => {
    const storage = pageStorage();
    const fresh = counter();
    const first = createPlayerIdentity(storage, fresh).current();
    expect(createPlayerIdentity(storage, fresh).current()).toBe(first);
  });

  test("differs between pages", () => {
    const fresh = counter();
    const a = createPlayerIdentity(pageStorage(), fresh).current();
    const b = createPlayerIdentity(pageStorage(), fresh).current();
    expect(a).not.toBe(b);
  });

  test("a renewed id is kept for the next reload", () => {
    const storage = pageStorage();
    const fresh = counter();
    const identity = createPlayerIdentity(storage, fresh);
    const renewed = identity.renew();
    expect(renewed).not.toBe("id-1");
    expect(identity.current()).toBe(renewed);
    expect(createPlayerIdentity(storage, fresh).current()).toBe(renewed);
  });

  test("failing or garbled storage gives a fresh id that lasts the page", () => {
    const failing: PlayerIdStorage = {
      get: () => {
        throw new Error("denied");
      },
      set: () => {
        throw new Error("denied");
      },
    };
    const identity = createPlayerIdentity(failing, counter());
    expect(identity.current()).toBe("id-1");
    expect(identity.renew()).toBe("id-2");

    const garbled = pageStorage();
    garbled.value = "";
    expect(createPlayerIdentity(garbled, counter()).current()).toBe("id-1");
    garbled.value = "x".repeat(65);
    expect(createPlayerIdentity(garbled, counter()).current()).toBe("id-1");
  });
});
