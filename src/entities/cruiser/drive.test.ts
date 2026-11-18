import { expect, test } from "vitest";
import { testEntitiesConfig } from "../../integration/sim-config.js";
import { enginePlaying, FRESH } from "./drive.js";

const { sounds } = testEntitiesConfig.cruiser;

test("its engine plays each run's sound as loud and as far as its config says", () => {
  const quiet = {
    ...sounds,
    idle: { volume: 0.01, range: 3 },
    reverse: { volume: 0.9, range: 77 },
  };
  expect(enginePlaying({ ...FRESH, engine: "off" }, quiet)).toBeNull();
  for (const engine of ["idle", "drive", "reverse"] as const) {
    const playing = enginePlaying({ ...FRESH, engine }, quiet);
    expect(playing).toMatchObject({
      key: `engine/${engine}`,
      volume: quiet[engine].volume,
      range: quiet[engine].range,
      loop: true,
    });
  }
});
