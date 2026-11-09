// The import-boundaries gate: dependency-cruiser over the targets below, then a check that it
// read every source file in them. A cruise that cannot parse a file finds no violations in
// it and still passes, so a source file on disk that is missing from the cruise stops the gate.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import console from "node:console";
import process from "node:process";

import { format } from "dependency-cruiser";

const TARGETS = ["src"];

/** The file types dependency-cruiser reads: .js .mjs .cjs .ts .mts .cts .tsx .jsx, and .d.* */
const SOURCE = /\.[mc]?[jt]sx?$/;

const sourceFiles = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && SOURCE.test(entry.name))
        .map((entry) => join(entry.parentPath, entry.name))
    : [path];

const cruise = spawnSync(
  join(import.meta.dirname, "..", "node_modules", ".bin", "depcruise"),
  ["--config", ".dependency-cruiser.mjs", "--output-type", "json", ...TARGETS],
  {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  },
);
if (cruise.status !== 0) {
  process.exit(cruise.status ?? 1);
}

const result = JSON.parse(cruise.stdout);
const cruised = new Set(result.modules.map((module) => module.source));
const missed = TARGETS.flatMap(sourceFiles).filter(
  (file) => !cruised.has(file),
);
if (missed.length > 0) {
  console.error(
    `dependency-cruiser read ${String(result.summary.totalCruised)} modules but left out ${String(missed.length)} source files, so their imports went unchecked:`,
  );
  missed.forEach((file) => console.error(`  ${file}`));
  console.error(
    "A file type it cannot parse (a TypeScript version it does not support) causes this.",
  );
  process.exit(1);
}

// The usual report and exit code, from the same cruise.
const { output, exitCode } = await format(result, { outputType: "err" });
process.stdout.write(output);
process.exitCode = exitCode;
