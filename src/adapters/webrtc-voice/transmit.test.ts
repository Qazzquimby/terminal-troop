import { describe, expect, test } from "vitest";
import type { VoiceMode } from "../../voice/index.js";
import { isTransmitting } from "./transmit.js";

describe("transmitting", () => {
  const cases: [VoiceMode, boolean, boolean, boolean][] = [
    // mode, talking, muted, transmitting
    ["open", false, false, true],
    ["open", true, false, true],
    ["open", false, true, false],
    ["open", true, true, false],
    ["pushToTalk", false, false, false],
    ["pushToTalk", true, false, true],
    ["pushToTalk", false, true, false],
    ["pushToTalk", true, true, false],
  ];
  test.each(cases)(
    "%s, talking %s, muted %s -> %s",
    (mode, talking, muted, expected) => {
      expect(isTransmitting(mode, talking, muted)).toBe(expected);
    },
  );
});
