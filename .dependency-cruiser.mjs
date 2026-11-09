// Import boundaries. A directory under src/ or src/adapters/ is a module: other code reaches it
// only through its public file. Every rule goes by directory, so a new file in a module is
// covered without this file changing. Tests sit inside the module they test and follow its
// rules; tests across modules, and helpers several modules share, live in src/integration/.

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Each directory here holds modules, one per child directory. */
const MODULE_PARENTS = ["src/adapters", "src"];

/** Directories under src that are not modules. */
const NOT_MODULES = new Set(["adapters", "integration"]);

/** Matches a path inside a module; group 1 is the module's directory. */
const IN_MODULE = "^(src/adapters/[^/]+|src/(?!adapters/|integration/)[^/]+)/";

const TEST = "\\.test\\.ts$|^src/integration/";

/** Source that ships: everything under src but tests and the integration directory. */
const PRODUCTION = { path: "^src/", pathNot: TEST };

const modulesIn = (parent) =>
  readdirSync(join(import.meta.dirname, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NOT_MODULES.has(entry.name))
    .map((entry) => `${parent}/${entry.name}`);

/**
 * A module's one public file: its index.ts, or the file named after it when its job is one
 * file. A module with neither stops the gate, so no module goes without a public file.
 */
const publicFileOf = (module) => {
  const file = ["index.ts", `${basename(module)}.ts`].find((name) =>
    existsSync(join(import.meta.dirname, module, name)),
  );
  if (file === undefined) {
    throw new Error(
      `${module} has no public file: add index.ts or ${basename(module)}.ts`,
    );
  }
  return `${module}/${file}`;
};

const PUBLIC_FILES = `^(${MODULE_PARENTS.flatMap(modulesIn)
  .map(publicFileOf)
  .join("|")
  .replaceAll(".", "\\.")})$`;

/** The files allowed at the top of src: entry points, and the test of one. */
const TOP_LEVEL = "^src/(bootstrap|env|env\\.test|vite-env\\.d)\\.ts$";

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
      "Code in one module imports another module only through its public file, types included. A module's tests may reach inside that module, and only that one. Add the name to the public file, or keep it inside.",
      { path: IN_MODULE },
      { path: IN_MODULE, pathNot: ["^$1/", PUBLIC_FILES] },
    ),
    rule(
      "module-public-file-from-outside",
      "Code outside every module (entry points, integration tests and their helpers) imports a module only through its public file, types included.",
      { pathNot: IN_MODULE },
      { path: IN_MODULE, pathNot: PUBLIC_FILES },
    ),
    rule(
      "no-tests-in-production",
      "Shipped code imports no test and nothing from src/integration.",
      PRODUCTION,
      { path: TEST },
    ),

    rule(
      "sim-inward",
      "The simulation imports only itself, the net module and the audio module: no rendering, input, voice, settings, UI or adapter.",
      { path: "^src/sim/", pathNot: TEST },
      { path: "^src/", pathNot: "^src/(sim|net|audio)/" },
    ),
    rule(
      "bootstrap-imported",
      "bootstrap.ts is the composition root; nothing imports it.",
      {},
      { path: "^src/bootstrap\\.ts$" },
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
      {
        path: "^src/(?!adapters/)",
        dependencyTypesNot: ["type-only"],
      },
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
      "src-file-without-module",
      "The top of src holds only entry points; anything else goes in a module directory.",
      { path: "^src/[^/]+$", pathNot: TOP_LEVEL },
      {},
    ),
    rule(
      "src-file-without-module-imported",
      "The top of src holds only entry points; anything else goes in a module directory.",
      {},
      { path: "^src/[^/]+$", pathNot: `${TOP_LEVEL}|^src/[^/]+\\.css$` },
    ),
    {
      name: "src-file-without-module-alone",
      comment:
        "The top of src holds only entry points; anything else goes in a module directory.",
      severity: "error",
      from: { orphan: true, path: "^src/[^/]+$", pathNot: TOP_LEVEL },
      to: {},
    },

    rule(
      "no-module-cycles",
      "Modules that import each other, types included, have no direction between them. Files inside one module may depend on each other.",
      { path: IN_MODULE, pathNot: TEST },
      { circular: true, viaSomeNot: "^$1/" },
    ),
    rule(
      "no-cycles-outside-modules",
      "Shipped files outside a module take part in no import cycle.",
      { path: "^src/", pathNot: `${IN_MODULE}|${TEST}` },
      { circular: true },
    ),
    {
      // An import that resolves to nothing would slip past every rule above.
      name: "resolves",
      comment: "Every import resolves, or the rules above cannot see it.",
      severity: "error",
      from: { path: "^src/" },
      to: { couldNotResolve: true },
    },
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
