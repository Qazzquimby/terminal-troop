import { describe, expect, test } from "vitest";
import { micIndicator } from "../src/engine/mic-indicator.js";

describe("micIndicator", () => {
  test.each([
    ["open", "live", false, false, "Open mic", "open"],
    ["open", "live", true, false, "Open mic", "open"],
    ["pushToTalk", "live", false, false, "Push to talk", "idle"],
    ["pushToTalk", "live", true, false, "Push to talk", "talking"],
    ["open", "live", true, true, "Muted", "muted"],
    ["pushToTalk", "live", false, true, "Muted", "muted"],
    ["open", "denied", false, false, "No mic", "off"],
    ["pushToTalk", "unavailable", false, true, "No mic", "off"],
    ["open", "pending", false, false, "Mic…", "off"],
  ] as const)(
    "%s, mic %s, transmitting %s, muted %s gives %s (%s)",
    (mode, mic, transmitting, muted, label, tone) => {
      expect(micIndicator({ mode, mic, transmitting }, muted)).toEqual({
        label,
        tone,
      });
    },
  );
});
