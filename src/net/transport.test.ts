import { expect, test } from "vitest";
import { NET_EVENTS, NetEvent } from "./transport.js";

test("NET_EVENTS lists every NetEvent once", () => {
  expect([...NET_EVENTS].sort()).toEqual(Object.values(NetEvent).sort());
});
