import { expect, test } from "vitest";
import { electHost } from "./host.js";

const active = (id: string) => ({ id, active: true });
const inactive = (id: string) => ({ id, active: false });

test("alone, the only player hosts", () => {
  expect(electHost(active("m"), [])).toBe("m");
  expect(electHost(inactive("m"), [])).toBe("m");
});

test("the lowest active id hosts", () => {
  expect(electHost(active("m"), [active("q"), active("c"), active("x")])).toBe(
    "c",
  );
});

test("an inactive player is passed over, however low its id", () => {
  expect(electHost(active("m"), [inactive("a"), active("q")])).toBe("m");
  expect(electHost(inactive("a"), [active("q"), active("m")])).toBe("m");
});

test("with no one active, the lowest id of all hosts", () => {
  expect(electHost(inactive("m"), [inactive("q"), inactive("c")])).toBe("c");
});

test("every player's view of the same room elects the same host", () => {
  const players = [active("q"), inactive("a"), active("m"), active("x")];
  const hosts = players.map((self, index) =>
    electHost(
      self,
      players.filter((_, other) => other !== index),
    ),
  );
  expect(new Set(hosts)).toEqual(new Set(["m"]));
});
