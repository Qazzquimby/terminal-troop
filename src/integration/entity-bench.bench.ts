import { max, min, sortBy, sumBy } from "lodash-es";
import { test } from "vitest";
import { z } from "zod";
import { config } from "../config.js";
import type { BenchConfig, BenchResult, Mix, Regime } from "./entity-bench.js";
import {
  benchDefaults,
  byKind,
  byPhase,
  onReferenceWorld,
  REFERENCE_MIX,
  REGIMES,
  runBench,
} from "./entity-bench.js";

/*
 * The entity-count sweep (#433): `pnpm bench:entities`. Not part of `pnpm test`; see
 * vitest.bench.config.ts. Tuned by environment:
 *
 * - BENCH_COUNTS: monster counts, comma separated
 * - BENCH_REGIMES: which of dormant, active, interacting
 * - BENCH_STEPS: steps timed at each count
 * - BENCH_STOP_MS: a regime's sweep stops past this mean ms a step
 * - BENCH_MIX: which mixes of kinds, comma separated, a row each (#470): shipped, by the
 *   spawner's weights; reference, the counts checked in as `REFERENCE_MIX`, so a weight tweak
 *   does not read as a regression; custom, as BENCH_MIX_CUSTOM has it ("zombie:20,statue:1")
 * - BENCH_WORLD: shipped, the world as configured; or reference, `REFERENCE_WORLD`'s map, so a
 *   resized map does not read as a regression
 * - BENCH_SEED: seeds for where monsters are placed and what they roll, comma separated
 * - BENCH_RUNS: runs of each seed; a row reports the median and least of their step means
 * - BENCH_LOADED_DRAW_MS: a run whose draw mean is past this is flagged, the machine likely
 *   busy with other work. The draw does not change with the entities' code, so it shows load.
 *
 * To compare commits, run them interleaved with BENCH_MIX=reference BENCH_WORLD=reference and
 * a few runs, and compare medians within one batch.
 */

// Vitest puts the process's environment on `import.meta.env`.
const env = z
  .object({
    BENCH_COUNTS: z.string().default("0,50,100,200,400,800,1600"),
    BENCH_REGIMES: z.string().default(REGIMES.join(",")),
    BENCH_STEPS: z.coerce.number().default(benchDefaults.steps),
    BENCH_STOP_MS: z.coerce.number().default(100),
    BENCH_MIX: z.string().default("shipped"),
    BENCH_MIX_CUSTOM: z.string().default(""),
    BENCH_WORLD: z.enum(["shipped", "reference"]).default("shipped"),
    BENCH_SEED: z.string().default(String(benchDefaults.seed)),
    BENCH_RUNS: z.coerce.number().int().positive().default(1),
    BENCH_LOADED_DRAW_MS: z.coerce.number().default(1.3),
  })
  .parse(import.meta.env);
const counts = env.BENCH_COUNTS.split(",").map(Number);
const regimes = env.BENCH_REGIMES.split(",").flatMap((name) =>
  REGIMES.filter((regime) => regime === name),
);
const steps = env.BENCH_STEPS;
const stopMs = env.BENCH_STOP_MS;
const seeds = env.BENCH_SEED.split(",").map(Number);
const loadedDrawMs = env.BENCH_LOADED_DRAW_MS;
const budgetMs = config.sim.fixedDt * 1000;

/** "zombie:20,statue:1" as counts by kind. */
const parseMix = (text: string): Record<string, number> =>
  Object.fromEntries(
    text
      .split(",")
      .map((pair) => pair.split(":"))
      .map(([kind = "", n = "0"]) => [kind, Number(n)]),
  );

const mixes = new Map<string, Mix>([
  ["shipped", "shipped"],
  ["reference", REFERENCE_MIX],
  ["custom", parseMix(env.BENCH_MIX_CUSTOM)],
]);
const chosenMixes = env.BENCH_MIX.split(",").flatMap((name) => {
  const mix = mixes.get(name);
  return mix === undefined ? [] : [{ name, mix }];
});

/** The shipped tuning: a bench, like bootstrap.ts, is a root that runs the game as shipped. */
const shipped: BenchConfig = {
  sim: config,
  entities: config.entities,
  items: config.items,
  moves: config.moves,
  clock: config.sim,
  sendHz: config.room.sendHz,
  camera: config.camera,
  flashes: config.flashes,
  ripples: config.ripples,
  mapMemory: config.mapMemory,
};
const benchConfig =
  env.BENCH_WORLD === "reference" ? onReferenceWorld(shipped) : shipped;

const ms = (value: number) => value.toFixed(2);

/** The middle of `values`, the upper of the two middles of an even count. */
const median = (values: readonly number[]): number =>
  sortBy(values)[values.length >> 1] ?? 0;

/** Whether a run's draw suggests the machine was busy with other work. */
const loaded = (result: BenchResult): boolean =>
  result.draw !== null && result.draw.mean > loadedDrawMs;

/** One regime at one count with one mix: every run of every seed. */
interface Row {
  readonly mix: string;
  readonly runs: readonly BenchResult[];
}

function stepTable(rows: readonly Row[]): string {
  const lines = rows.map(({ mix, runs }) => {
    const [first] = runs;
    if (first === undefined) return "";
    const means = runs.map((run) => run.step.mean);
    const draws = runs.flatMap((run) =>
      run.draw === null ? [] : [run.draw.mean],
    );
    const busy = runs.filter(loaded).length;
    return `| ${[
      first.regime,
      mix,
      first.count,
      first.entitiesAtEnd,
      runs.length,
      ms(median(means)),
      ms(min(means) ?? 0),
      ms(median(runs.map((run) => run.step.median))),
      ms(median(runs.map((run) => run.step.p95))),
      ms(max(runs.map((run) => run.step.max)) ?? 0),
      draws.length === 0 ? "-" : ms(median(draws)),
      ms(median(runs.map((run) => run.send.mean))),
      sumBy(runs, (run) => run.replaced),
      busy === 0 ? "" : `${String(busy)}/${String(runs.length)}`,
    ].join(" | ")} |`;
  });
  return [
    "| regime | mix | N | entities | runs | step mean (median) | step mean (least) | step median | step p95 | step max | draw mean | send mean | replaced | loaded |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...lines,
  ].join("\n");
}

function topTable(
  title: string,
  entries: readonly (readonly [string, number])[],
): string {
  return [
    `| ${title} | ms/step |`,
    "|---|---|",
    ...entries
      .slice(0, 12)
      .map(([label, value]) => `| ${label} | ${ms(value)} |`),
  ].join("\n");
}

/** Each kind's ms a step, how many there were, and µs a step for each. */
function kindTable(result: BenchResult): string {
  return [
    "| kind | ms/step | count | µs/entity/step |",
    "|---|---|---|---|",
    ...byKind(result.parts)
      .slice(0, 25)
      .map(([kind, value]) => {
        const count = result.kinds.get(kind) ?? 0;
        const each = count === 0 ? "-" : ((value * 1000) / count).toFixed(1);
        return `| ${kind} | ${ms(value)} | ${String(count)} | ${each} |`;
      }),
  ].join("\n");
}

/** The least count in `rows` whose median p95 step is past the step budget. */
function overBudget(rows: readonly Row[], regime: Regime): string {
  const over = rows.find(
    ({ runs }) =>
      runs[0]?.regime === regime &&
      median(runs.map((run) => run.step.p95)) > budgetMs,
  );
  return over?.runs[0] === undefined
    ? "not reached"
    : `N = ${String(over.runs[0].count)}`;
}

/** Every run of every seed of `regime` at `count` with `mix`; only the first is broken down. */
function runRow(regime: Regime, count: number, mix: Mix): BenchResult[] {
  const runs: BenchResult[] = [];
  for (let run = 0; run < env.BENCH_RUNS; run++)
    for (const seed of seeds) {
      const result = runBench(benchConfig, {
        ...benchDefaults,
        regime,
        count,
        steps,
        seed,
        mix,
        breakdown: runs.length === 0 && benchDefaults.breakdown,
      });
      runs.push(result);
      console.log(
        `${regime} N=${String(count)} seed=${String(seed)} run=${String(run + 1)}: step mean ${ms(result.step.mean)}, median ${ms(result.step.median)}, draw mean ${result.draw === null ? "-" : ms(result.draw.mean)}${loaded(result) ? " (loaded?)" : ""}`,
      );
    }
  return runs;
}

test(
  "entity-count sweep",
  () => {
    const rows: Row[] = [];
    for (const { name, mix } of chosenMixes)
      for (const regime of regimes)
        for (const count of counts) {
          const row = { mix: name, runs: runRow(regime, count, mix) };
          rows.push(row);
          console.log(stepTable([row]).split("\n")[2]);
          if (median(row.runs.map((run) => run.step.mean)) > stopMs) break;
        }

    const report = [
      `Step budget: ${ms(budgetMs)} ms (fixedDt). Times in ms. ${String(steps)} steps timed per run; ${String(benchDefaults.players)} players held still. World: ${env.BENCH_WORLD}. Seeds: ${seeds.join(",")}, ${String(env.BENCH_RUNS)} run(s) each. Runs whose draw mean passed ${ms(loadedDrawMs)} ms are counted under "loaded".`,
      "",
      stepTable(rows),
      "",
      ...chosenMixes.flatMap(({ name }) =>
        regimes.map(
          (regime) =>
            `- ${name}, ${regime}: p95 step over budget from ${overBudget(
              rows.filter((row) => row.mix === name),
              regime,
            )}`,
        ),
      ),
      "",
      ...chosenMixes.flatMap(({ name }) =>
        regimes.flatMap((regime) => {
          const largest = rows
            .filter((row) => row.mix === name && row.runs[0]?.regime === regime)
            .at(-1)?.runs[0];
          if (largest === undefined) return [];
          return [
            `### ${name}, ${regime}, N = ${String(largest.count)}`,
            "",
            topTable("phase", byPhase(largest.parts)),
            "",
            kindTable(largest),
            "",
            topTable("part", largest.parts),
            "",
          ];
        }),
      ),
    ].join("\n");
    console.log(report);
  },
  24 * 60 * 60 * 1000,
);
