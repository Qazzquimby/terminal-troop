import { expect, test } from "vitest";
import { wheelCaption } from "./cabin.js";
import { doorCaption, doorLabel } from "./cabin-door.js";
import { clampBet, tossCaption } from "./cabin-finances.js";
import { saleTag } from "./cabin-stock.js";

test("the wheel panel names everyone at the wheel", () => {
  expect(wheelCaption([])).toBe("nobody is driving!!");
  expect(wheelCaption(["ANN"])).toBe("ANN has the wheel");
  expect(wheelCaption(["ANN", "BOB"])).toBe(
    "ANN + BOB are fighting over the wheel",
  );
});

test("the door panel offers to shut an open door with power to, or open a shut one", () => {
  const open = { closed: false, canClose: true, charge: 1 };
  expect(doorLabel(open)).toBe("SHUT DOOR");
  expect(doorLabel({ ...open, canClose: false })).toBe("LOW POWER");
  expect(doorLabel({ ...open, closed: true })).toBe("OPEN DOOR");
  expect(doorCaption(open)).toMatch(/seen/);
  expect(doorCaption({ ...open, closed: true })).toMatch(/sealed/);
});

test("the coin toss's bet stays a whole credit or more, and no more than the team has", () => {
  expect(clampBet(0, 10)).toBe(1);
  expect(clampBet(12, 10)).toBe(10);
  expect(clampBet(3.7, 10)).toBe(3);
});

test("the coin panel says who has the coin up, else how the last came down", () => {
  expect(tossCaption({ tossing: null, last: null })).toMatch(
    /double or nothing/,
  );
  expect(tossCaption({ tossing: { by: "ANN", bet: 3 }, last: null })).toBe(
    "ANN bets 3$...",
  );
  const last = { by: "BOB", bet: 4, n: 1, won: true };
  expect(tossCaption({ tossing: null, last })).toBe("BOB WON 8$!!");
  expect(tossCaption({ tossing: null, last: { ...last, won: false } })).toMatch(
    /BOB lost 4\$/,
  );
  expect(saleTag(40)).toBe("-40%");
});
