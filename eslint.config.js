import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import vitest from "@vitest/eslint-plugin";

// Disable comments do nothing (`noInlineConfig`); an exception is a rule scope in this file.

const NO_PREDICATES = [
  {
    selector: "TSTypePredicate",
    message:
      "No hand-written type predicates: parse with a schema, or let TypeScript infer the predicate.",
  },
];

const NO_EXPORT_STAR = [
  {
    selector: "ExportAllDeclaration",
    message: "No export *: a public file lists its names.",
  },
];

// A public file lists its own module's files, so no module re-exports another.
const NO_OUTSIDE_REEXPORTS = [
  {
    selector: "ExportNamedDeclaration[source][source.value!=/^\\.\\//]",
    message:
      "A module re-exports only its own files; import the other module where it is used.",
  },
];

const NO_REDUCE = ["reduce", "reduceRight"].map((name) => ({
  selector: `CallExpression[callee.property.name='${name}']`,
  message:
    "reduce obscures intent: use map/filter/Object.fromEntries/a loop, or a lodash-es helper (sum, groupBy, keyBy, ...).",
}));

// Only the input module handles raw input; everything else reads actions and Controls.
const RAW_INPUT_MESSAGE =
  "Raw input belongs to the input module; read actions and Controls instead.";
const NO_RAW_INPUT = [
  "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^(key|pointer|mouse|touch|wheel|contextmenu)/]",
  "AssignmentExpression[left.property.name=/^on(key|pointer|mouse|touch|wheel|contextmenu)/]",
  "TSTypeReference[typeName.name=/^(Keyboard|Pointer|Mouse|Wheel|Touch)Event$/]",
  "NewExpression[callee.name=/^(Keyboard|Pointer|Mouse|Wheel|Touch)Event$/]",
  "MemberExpression[property.name='getGamepads']",
].map((selector) => ({ selector, message: RAW_INPUT_MESSAGE }));

const TS_RESTRICTED_SYNTAX = [
  ...NO_EXPORT_STAR,
  ...NO_OUTSIDE_REEXPORTS,
  ...NO_PREDICATES,
  ...NO_REDUCE,
];

const TEST_SOURCE = ["src/**/*.test.ts"];

// Content declares what it does through the actions framework; the sim's network and host-record
// primitives are the framework's to call.
const CONTENT_SOURCE = [
  "src/entities/**/*.ts",
  "src/items/**/*.ts",
  "src/moves/**/*.ts",
];
const NETWORK_PRIMITIVES = [
  "contentEvent",
  "receiveEvent",
  "correctPlayer",
  "hurtPlayer",
  "giveItem",
  "takeItem",
  "spawnEntity",
  "removeEntity",
  "applyRemoteState",
  "applyEntityChanges",
  "applyEntitySnapshot",
  "applyWorldEntries",
  "takeWorldEntries",
  "takeOverForcedMoves",
];

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", ".claude/worktrees/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    linterOptions: { noInlineConfig: true },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": true,
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      // assertionStyle "never" still permits `as const`, and also bans the <T>x form.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "no-restricted-syntax": [
        "error",
        ...TS_RESTRICTED_SYNTAX,
        ...NO_RAW_INPUT,
      ],
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    // The input module (tests included) is the one place raw input is handled.
    files: ["src/input/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", ...TS_RESTRICTED_SYNTAX] },
  },
  {
    files: CONTENT_SOURCE,
    ignores: TEST_SOURCE,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/sim/index.js"],
              importNames: NETWORK_PRIMITIVES,
              message:
                "Content acts through the actions framework (defineAction, hurt, push, effect, give, take, spawn, ...), not the sim's network or host-record primitives.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-restricted-syntax": ["error", ...NO_REDUCE],
    },
  },
  {
    // A focused or skipped test quietly shrinks the gate. it.fails stays legal: it runs, and
    // goes red when the known bug it states is fixed.
    files: TEST_SOURCE,
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
    },
  },
  prettier,
);
