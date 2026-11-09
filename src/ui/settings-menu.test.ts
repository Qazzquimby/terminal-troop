import { expect, test } from "vitest";
import { menuPeers } from "./settings-menu.js";

const player = (id: string, name: string) => ({ id, name });
const nobodyAway = () => false;

test("lists the given players sorted by name, with their mute and away flags", () => {
  const remotes = [player("c", "ZED"), player("a", "ANN"), player("b", "BOB")];
  expect(menuPeers(remotes, ["b", "gone"], (id) => id === "c")).toEqual([
    { id: "a", name: "ANN", muted: false, away: false },
    { id: "b", name: "BOB", muted: true, away: false },
    { id: "c", name: "ZED", muted: false, away: true },
  ]);
});

test("players sharing a name are ordered by id", () => {
  const players = [player("y", "SAM"), player("x", "SAM")];
  expect(menuPeers(players, [], nobodyAway).map(({ id }) => id)).toEqual([
    "x",
    "y",
  ]);
});

test("no players lists no one", () => {
  expect(menuPeers([], ["me"], nobodyAway)).toEqual([]);
});
