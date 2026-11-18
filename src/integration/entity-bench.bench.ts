import { test } from "vitest";
import { z } from "zod";
import { config } from "../config.js";
import type { BenchConfig, BenchResult, Regime } from "./entity-bench.js";
import {
  benchDefaults,
  byKind,
  byPhase,
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
 */

// Vitest puts the process's environment on `import.meta.env`.
const env = z
  .object({
    BENCH_COUNTS: z.string().default("0,50,100,200,400,800,1600"),
    BENCH_REGIMES: z.string().default(REGIMES.join(",")),
    BENCH_STEPS: z.coerce.number().default(benchDefaults.steps),
    BENCH_STOP_MS: z.coerce.number().default(100),
  })
  .parse(import.meta.env);
const counts = env.BENCH_COUNTS.split(",").map(Number);
const regimes = env.BENCH_REGIMES.split(",").flatMap((name) =>
  REGIMES.filter((regime) => regime === name),
);
const steps = env.BENCH_STEPS;
const stopMs = env.BENCH_STOP_MS;
const budgetMs = config.sim.fixedDt * 1000;

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

const ms = (value: number) => value.toFixed(2);

function stepTable(results: readonly BenchResult[]): string {
  const rows = results.map((result) =>
    [
      result.regime,
      result.count,
      result.entitiesAtEnd,
      ms(result.step.mean),
      ms(result.step.p95),
      ms(result.step.max),
      result.draw === null ? "-" : ms(result.draw.mean),
      result.draw === null ? "-" : ms(result.draw.p95),
      ms(result.send.mean),
      result.replaced,
    ].join(" | "),
  );
  return [
    "| regime | N | entities | step mean | step p95 | step max | draw mean | draw p95 | send mean | replaced |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
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
      .slice(0, 15)
      .map(([kind, value]) => {
        const count = result.kinds.get(kind) ?? 0;
        const each = count === 0 ? "-" : ((value * 1000) / count).toFixed(1);
        return `| ${kind} | ${ms(value)} | ${String(count)} | ${each} |`;
      }),
  ].join("\n");
}

/** The least count in `results` whose p95 step is past the step budget. */
function overBudget(results: readonly BenchResult[], regime: Regime): string {
  const over = results.find(
    (result) => result.regime === regime && result.step.p95 > budgetMs,
  );
  return over === undefined ? "not reached" : `N = ${String(over.count)}`;
}

test(
  "entity-count sweep",
  () => {
    const results: BenchResult[] = [];
    for (const regime of regimes)
      for (const count of counts) {
        const result = runBench(shipped, {
          ...benchDefaults,
          regime,
          count,
          steps,
        });
        results.push(result);
        console.log(stepTable([result]).split("\n")[2]);
        if (result.step.mean > stopMs) break;
      }

    const report = [
      `Step budget: ${ms(budgetMs)} ms (fixedDt). Times in ms. ${String(steps)} steps timed per row; ${String(benchDefaults.players)} players held still.`,
      "",
      stepTable(results),
      "",
      ...regimes.map(
        (regime) =>
          `- ${regime}: p95 step over budget from ${overBudget(results, regime)}`,
      ),
      "",
      ...regimes.flatMap((regime) => {
        const largest = results
          .filter((result) => result.regime === regime)
          .at(-1);
        if (largest === undefined) return [];
        return [
          `### ${regime}, N = ${String(largest.count)}`,
          "",
          topTable("phase", byPhase(largest.parts)),
          "",
          kindTable(largest),
          "",
          topTable("part", largest.parts),
          "",
        ];
      }),
    ].join("\n");
    console.log(report);
  },
  24 * 60 * 60 * 1000,
);
