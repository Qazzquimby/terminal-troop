import { expect, test } from "vitest";
import { wheelCaption } from "./cabin.js";
import { doorCaption, doorLabel } from "./cabin-door.js";

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
