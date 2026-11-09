import { describe, expect, test } from "vitest";
import { adopt, elect } from "./host.js";
import type { HostView } from "./host.js";

const active = (id: string, view: HostView | null = null) => ({
  id,
  active: true,
  view,
});
const inactive = (id: string, view: HostView | null = null) => ({
  id,
  active: false,
  view,
});
const room = (id: string, term: number): HostView => ({
  id,
  term,
  solo: false,
});
const solo = (id: string, term: number): HostView => ({
  id,
  term,
  solo: true,
});

describe("the first election", () => {
  test("alone, the only player hosts solo at term 0", () => {
    expect(elect(undefined, active("m"), [])).toEqual(solo("m", 0));
    expect(elect(undefined, inactive("m"), [])).toEqual(solo("m", 0));
  });

  test("chooses the lowest active id", () => {
    expect(
      elect(undefined, active("m"), [active("q"), active("c"), active("x")]),
    ).toEqual(room("c", 0));
  });

  test("passes over an inactive player, however low its id", () => {
    expect(elect(undefined, active("m"), [inactive("a"), active("q")])).toEqual(
      room("m", 0),
    );
  });

  test("with no one active, chooses the lowest id of all, solo", () => {
    expect(
      elect(undefined, inactive("m"), [inactive("q"), inactive("c")]),
    ).toEqual(solo("c", 0));
  });
});

describe("a held view", () => {
  test("stays while its host is active, even when a lower id is", () => {
    const held = room("m", 3);
    expect(elect(held, active("m"), [active("a")])).toBe(held);
  });

  test("gives way a term later when its host is inactive or gone", () => {
    expect(
      elect(room("a", 3), active("q"), [inactive("a"), active("m")]),
    ).toEqual(room("m", 4));
    expect(elect(room("a", 3), active("q"), [active("m")])).toEqual(
      room("m", 4),
    );
  });

  test("gives way to a solo election when no other player is active", () => {
    expect(elect(room("a", 3), active("q"), [inactive("a")])).toEqual(
      solo("q", 4),
    );
  });

  test("stays while no one is active and its host is still a candidate", () => {
    const held = room("q", 2);
    expect(elect(held, inactive("a"), [inactive("q")])).toBe(held);
    expect(elect(held, inactive("a"), [])).toEqual(solo("a", 3));
  });
});

describe("a solo view", () => {
  test("stops being solo once an active player holds it too", () => {
    expect(
      elect(solo("m", 2), active("m"), [active("q", solo("m", 2))]),
    ).toEqual(room("m", 2));
  });

  test("stays solo beside active players that hold another view, or none yet", () => {
    const held = solo("q", 2);
    expect(elect(held, active("q"), [active("a", room("a", 0))])).toBe(held);
    expect(elect(held, active("q"), [active("a")])).toBe(held);
    expect(elect(held, active("q"), [inactive("a", held)])).toBe(held);
  });
});

describe("hearing a view", () => {
  test("a client without a view takes the first it hears, solo or not", () => {
    expect(adopt(undefined, solo("q", 0))).toEqual(solo("q", 0));
    expect(adopt(undefined, null)).toBeUndefined();
  });

  test("a higher term overrules, whatever the ids", () => {
    expect(adopt(room("a", 1), room("q", 2))).toEqual(room("q", 2));
    expect(adopt(room("q", 2), room("a", 1))).toEqual(room("q", 2));
  });

  test("at the same term the lower id overrules", () => {
    expect(adopt(room("q", 2), room("m", 2))).toEqual(room("m", 2));
    expect(adopt(room("m", 2), room("q", 2))).toEqual(room("m", 2));
    expect(adopt(solo("q", 2), solo("m", 2))).toEqual(solo("m", 2));
  });

  test("a view of the room overrules a solo view, whatever the terms", () => {
    expect(adopt(solo("a", 5), room("q", 1))).toEqual(room("q", 1));
    expect(adopt(room("q", 1), solo("a", 5))).toEqual(room("q", 1));
    expect(adopt(solo("q", 1), room("q", 1))).toEqual(room("q", 1));
  });

  test("a sender without a view changes nothing", () => {
    const held = room("q", 2);
    expect(adopt(held, null)).toBe(held);
  });

  test("clients that elected apart agree once each hears the others", () => {
    const views = [room("a", 0), solo("b", 2), room("q", 1), room("m", 1)];
    const agreed = views.map((own) => {
      let held: HostView | undefined = own;
      for (const heard of views) held = adopt(held, heard);
      return held;
    });
    expect(agreed).toEqual(views.map(() => room("m", 1)));
  });
});
