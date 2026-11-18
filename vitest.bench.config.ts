import { defineConfig } from "vitest/config";

// The benchmarks, kept out of `pnpm test`: `pnpm bench:entities`. For a V8 CPU profile of a run,
// add `--execArgv=--cpu-prof --execArgv=--cpu-prof-dir=.cpuprofile`.
export default defineConfig({
  test: {
    include: ["src/**/*.bench.ts"],
    silent: false,
    testTimeout: 0,
    pool: "forks",
  },
});
