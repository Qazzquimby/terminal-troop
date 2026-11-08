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

const NO_REDUCE = ["reduce", "reduceRight"].map((name) => ({
  selector: `CallExpression[callee.property.name='${name}']`,
  message:
    "reduce obscures intent: use map/filter/Object.fromEntries/a loop, or a lodash-es helper (sum, groupBy, keyBy, ...).",
}));

const TEST_SOURCE = ["tests/**"];

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
        ...NO_EXPORT_STAR,
        ...NO_PREDICATES,
        ...NO_REDUCE,
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
    files: ["**/*.js"],
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
