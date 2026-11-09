import { describe, expect, test } from "vitest";
import { adopt, elect } from "./host.js";
import type { HostView } from "./host.js";

const active = (id: string) => ({ id, active: true });
const inactive = (id: string) => ({ id, active: false });
const view = (id: string, term: number): HostView => ({ id, term });

describe("the first election", () => {
  test("alone, the only player hosts at term 0", () => {
    expect(elect(undefined, [active("m")])).toEqual(view("m", 0));
    expect(elect(undefined, [inactive("m")])).toEqual(view("m", 0));
  });

  test("chooses the lowest active id", () => {
    expect(
      elect(undefined, [active("m"), active("q"), active("c"), active("x")]),
    ).toEqual(view("c", 0));
  });

  test("passes over an inactive player, however low its id", () => {
    expect(elect(undefined, [active("m"), inactive("a"), active("q")])).toEqual(
      view("m", 0),
    );
  });

  test("with no one active, chooses the lowest id of all", () => {
    expect(
      elect(undefined, [inactive("m"), inactive("q"), inactive("c")]),
    ).toEqual(view("c", 0));
  });
});

describe("a held view", () => {
  test("stays while its host is active, even when a lower id is", () => {
    const held = view("m", 3);
    expect(elect(held, [active("a"), active("m")])).toBe(held);
  });

  test("gives way a term later when its host is inactive or gone", () => {
    expect(
      elect(view("a", 3), [inactive("a"), active("q"), active("m")]),
    ).toEqual(view("m", 4));
    expect(elect(view("a", 3), [active("q"), active("m")])).toEqual(
      view("m", 4),
    );
  });

  test("stays while no one is active and its host is still a candidate", () => {
    const held = view("q", 2);
    expect(elect(held, [inactive("a"), inactive("q")])).toBe(held);
    expect(elect(held, [inactive("a")])).toEqual(view("a", 3));
  });
});

describe("hearing a view", () => {
  test("a client without a view takes the first it hears", () => {
    expect(adopt(undefined, view("q", 0))).toEqual(view("q", 0));
    expect(adopt(undefined, null)).toBeUndefined();
  });

  test("a higher term overrules, whatever the ids", () => {
    expect(adopt(view("a", 1), view("q", 2))).toEqual(view("q", 2));
    expect(adopt(view("q", 2), view("a", 1))).toEqual(view("q", 2));
  });

  test("at the same term the lower id overrules", () => {
    expect(adopt(view("q", 2), view("m", 2))).toEqual(view("m", 2));
    expect(adopt(view("m", 2), view("q", 2))).toEqual(view("m", 2));
  });

  test("a sender without a view changes nothing", () => {
    const held = view("q", 2);
    expect(adopt(held, null)).toBe(held);
  });

  test("clients that elected apart agree once each hears the others", () => {
    const views = [view("a", 0), view("q", 1), view("m", 1)];
    const agreed = views.map((own) => {
      let held: HostView | undefined = own;
      for (const heard of views) held = adopt(held, heard);
      return held;
    });
    expect(agreed).toEqual([view("m", 1), view("m", 1), view("m", 1)]);
  });
});
