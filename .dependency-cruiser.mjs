// Import boundaries. A directory under src/ or src/adapters/ is a module: other code reaches it
// only through its index.ts. Every rule goes by directory, so a new file in a module is covered
// without this file changing. Tests sit inside the module they test and follow its rules; tests
// across modules, and helpers several modules share, live in src/integration/.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Each directory here holds modules, one per child directory. */
const MODULE_PARENTS = ["src/adapters", "src"];

/** Directories under src that are not modules. */
const NOT_MODULES = new Set(["adapters", "integration"]);

/** Matches a path inside a module; group 1 is the module's directory. */
const IN_MODULE = "^(src/adapters/[^/]+|src/(?!adapters/|integration/)[^/]+)/";

/**
 * Matches any path under src; group 1 is the directory or top-level file it sits in, so `^$1/`
 * matches the other files of the same module, and nothing for a top-level file.
 */
const UNIT = "^(src/adapters/[^/]+|src/(?!adapters/)[^/]+)";

const TEST = "\\.test\\.ts$|^src/integration/";

/** Source that ships: everything under src but tests and the integration directory. */
const PRODUCTION = { path: "^src/", pathNot: TEST };

/** The files allowed at the top of src: entry points, and the test of one. */
const TOP_LEVEL = new Set([
  "bootstrap.ts",
  "env.ts",
  "env.test.ts",
  "vite-env.d.ts",
]);

const entriesOf = (dir) =>
  readdirSync(join(import.meta.dirname, dir), { withFileTypes: true });

const modulesIn = (parent) =>
  entriesOf(parent)
    .filter((entry) => entry.isDirectory() && !NOT_MODULES.has(entry.name))
    .map((entry) => `${parent}/${entry.name}`);

/** A module's one public file is its index.ts; a module without one stops the gate. */
const publicFileOf = (module) => {
  if (!existsSync(join(import.meta.dirname, module, "index.ts"))) {
    throw new Error(`${module} has no public file: add ${module}/index.ts`);
  }
  return `${module}/index.ts`;
};

const PUBLIC_FILES = `^(${MODULE_PARENTS.flatMap(modulesIn)
  .map(publicFileOf)
  .join("|")
  .replaceAll(".", "\\.")})$`;

/** The top of src holds only entry points; any other file there stops the gate. */
const strays = entriesOf("src")
  .filter((entry) => !entry.isDirectory() && !TOP_LEVEL.has(entry.name))
  .map((entry) => `src/${entry.name}`);
if (strays.length > 0) {
  throw new Error(
    `The top of src holds only entry points; move into a module: ${strays.join(", ")}`,
  );
}

const rule = (name, comment, from, to) => ({
  name,
  comment,
  severity: "error",
  from,
  to,
});

export default {
  forbidden: [
    rule(
      "module-public-file",
      "Code reaches a module only through its index.ts, types included. A module's own files, its tests among them, may reach inside that module and no other. Add the name to the index, or keep it inside.",
      { path: UNIT },
      { path: IN_MODULE, pathNot: ["^$1/", PUBLIC_FILES] },
    ),
    rule(
      "no-module-cycles",
      "Shipped code takes part in no import cycle that leaves a module, types included, so every dependency between modules has one direction. Files inside one module may depend on each other.",
      { path: UNIT, pathNot: TEST },
      { circular: true, viaSomeNot: "^$1/" },
    ),
    rule(
      "adapter-to-adapter",
      "An adapter imports only its own files, however harmless the other adapter's file looks. Inject what it needs from bootstrap.ts.",
      { path: "^src/adapters/([^/]+)/" },
      { path: "^src/adapters/", pathNot: "^src/adapters/$1/" },
    ),
    rule(
      "adapter-to-module-value",
      "An adapter imports port and domain types with `import type`, and values only from its own files and npm packages. A value the rest of the app also needs is injected or passed through the port.",
      { path: "^src/adapters/", pathNot: TEST },
      { path: "^src/(?!adapters/)", dependencyTypesNot: ["type-only"] },
    ),
    rule(
      "adapter-outside-root",
      "Only bootstrap.ts, the composition root, imports adapters; integration tests may too.",
      {
        path: "^src/",
        pathNot: "^src/(bootstrap\\.ts$|adapters/|integration/)",
      },
      { path: "^src/adapters/" },
    ),
    rule(
      "bootstrap-imported",
      "bootstrap.ts is the composition root; nothing imports it.",
      {},
      { path: "^src/bootstrap\\.ts$" },
    ),
    rule(
      "no-tests-in-production",
      "Shipped code imports no test and nothing from src/integration.",
      PRODUCTION,
      { path: TEST },
    ),
    // An import that resolves to nothing would slip past every rule above.
    rule(
      "resolves",
      "Every import resolves, or the rules above cannot see it.",
      { path: "^src/" },
      { couldNotResolve: true },
    ),
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "browser", "default"],
      extensions: [".ts", ".js", ".json"],
    },
  },
};
