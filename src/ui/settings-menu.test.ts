import { expect, test } from "vitest";
import { menuPeers } from "./settings-menu.js";

const player = (id: string, name: string) => ({ id, name });

test("lists everyone but the local player, by name, with their mutes", () => {
  const remotes = [player("c", "ZED"), player("a", "ANN"), player("b", "BOB")];
  expect(menuPeers(remotes, ["b", "gone"])).toEqual([
    { id: "a", name: "ANN", muted: false },
    { id: "b", name: "BOB", muted: true },
    { id: "c", name: "ZED", muted: false },
  ]);
});

test("players sharing a name keep a stable order", () => {
  const players = [player("y", "SAM"), player("x", "SAM")];
  expect(menuPeers(players, []).map(({ id }) => id)).toEqual(["x", "y"]);
});

test("alone in the room lists no one", () => {
  expect(menuPeers([], ["me"])).toEqual([]);
});
