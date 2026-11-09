import { expect, test } from "vitest";
import { menuPeers } from "../src/settings-menu.js";

const player = (id: string, name: string) => ({ id, name });

test("lists everyone but the local player, by name, with their mutes", () => {
  const players = [
    player("me", "ME"),
    player("c", "ZED"),
    player("a", "ANN"),
    player("b", "BOB"),
  ];
  expect(menuPeers(players, "me", ["b", "gone"])).toEqual([
    { id: "a", name: "ANN", muted: false },
    { id: "b", name: "BOB", muted: true },
    { id: "c", name: "ZED", muted: false },
  ]);
});

test("players sharing a name keep a stable order", () => {
  const players = [player("y", "SAM"), player("x", "SAM")];
  expect(menuPeers(players, "me", []).map(({ id }) => id)).toEqual(["x", "y"]);
});

test("alone in the room lists no one", () => {
  expect(menuPeers([player("me", "ME")], "me", ["me"])).toEqual([]);
});
