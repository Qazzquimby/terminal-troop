import { describe, expect, test } from "vitest";
import type { MicPermission, MicState } from "../../voice/index.js";
import { micConstraints, micLevel, micPermission } from "./mic.js";

describe("micPermission", () => {
  test.each<[boolean, PermissionState | null, MicState, MicPermission]>([
    [false, null, "unavailable", "unavailable"],
    [false, "granted", "live", "unavailable"],
    [true, "granted", "denied", "denied"],
    [true, "prompt", "live", "granted"],
    [true, "denied", "pending", "denied"],
    [true, "prompt", "pending", "prompt"],
    [true, null, "pending", "prompt"],
    [true, "granted", "unavailable", "granted"],
  ])(
    "supported %s, reported %s, mic %s: %s",
    (supported, reported, state, expected) => {
      expect(micPermission(supported, reported, state)).toBe(expected);
    },
  );
});

describe("micLevel", () => {
  test("silence is 0 and full scale is 1", () => {
    expect(micLevel(new Float32Array(16))).toBe(0);
    expect(micLevel(new Float32Array(16).fill(1))).toBe(1);
  });

  test("-30 dBFS sits halfway", () => {
    expect(micLevel(new Float32Array(16).fill(10 ** (-30 / 20)))).toBeCloseTo(
      0.5,
    );
  });
});

test("a chosen device is asked for, the default otherwise", () => {
  expect(micConstraints("usb").audio).toMatchObject({
    deviceId: { exact: "usb" },
  });
  expect(micConstraints(null).audio).not.toHaveProperty("deviceId");
});
