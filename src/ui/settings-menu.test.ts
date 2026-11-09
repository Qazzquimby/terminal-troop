import { expect, test } from "vitest";
import { menuPeers } from "./settings-menu.js";

const player = (id: string, name: string) => ({ id, name });

test("lists the given players sorted by name, with their mute flags", () => {
  const remotes = [player("c", "ZED"), player("a", "ANN"), player("b", "BOB")];
  expect(menuPeers(remotes, ["b", "gone"])).toEqual([
    { id: "a", name: "ANN", muted: false },
    { id: "b", name: "BOB", muted: true },
    { id: "c", name: "ZED", muted: false },
  ]);
});

test("players sharing a name are ordered by id", () => {
  const players = [player("y", "SAM"), player("x", "SAM")];
  expect(menuPeers(players, []).map(({ id }) => id)).toEqual(["x", "y"]);
});

test("no players lists no one", () => {
  expect(menuPeers([], ["me"])).toEqual([]);
});
