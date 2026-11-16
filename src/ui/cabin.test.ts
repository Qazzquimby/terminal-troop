import { expect, test } from "vitest";
import { wheelCaption } from "./cabin.js";

test("the wheel panel names everyone at the wheel", () => {
  expect(wheelCaption([])).toBe("nobody is driving!!");
  expect(wheelCaption(["ANN"])).toBe("ANN has the wheel");
  expect(wheelCaption(["ANN", "BOB"])).toBe(
    "ANN + BOB are fighting over the wheel",
  );
});
