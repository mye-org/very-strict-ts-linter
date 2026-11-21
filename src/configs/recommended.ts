import type { TSESLint } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import tseslint from "typescript-eslint";
import { rules } from "../rules/index.js";

export type StrictFpConfigOptions = Partial<
  Record<"files" | "boundaryFiles" | "testFiles", ReadonlyArray<string>> &
    Record<"maxFunctionLines", number>
>;

const baseStrictFpRules = {
  "strict-fp/fp-ts-import-convention": "error",
  "strict-fp/no-any-or-unknown": "error",
  "strict-fp/no-domain-raw-primitives": "error",
  "strict-fp/no-explicit-return-type": "error",
  "strict-fp/no-if-else-or-switch": "error",
  "strict-fp/no-imperative-loops": "error",
  "strict-fp/no-let-or-var": "error",
  "strict-fp/no-nested-ternary": "error",
  "strict-fp/no-null-undefined": "error",
  "strict-fp/no-throw-outside-unsafe": "error",
  "strict-fp/no-unnecessary-local-const": "error",
  "strict-fp/prefer-fp-ts-array-methods": "error",
  "strict-fp/prefer-function-composition": "error",
  "strict-fp/prefer-monadic-composition": "error",
  "strict-fp/prefer-monadic-error-handling": "error",
  "strict-fp/prefer-readonly-collections": "error",
  "strict-fp/prefer-type-over-interface": "error",
  "strict-fp/require-exhaustive-match": "error",
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
  "@typescript-eslint/no-explicit-any": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

export const strictFpRules = (maxLines = 15) =>
  ({
    ...baseStrictFpRules,
    "strict-fp/max-function-lines": ["error", { maxLines }],
  }) satisfies TSESLint.FlatConfig.Rules;

const boundaryOverrideRules = {
  "strict-fp/no-throw-outside-unsafe": "off",
  "strict-fp/no-if-else-or-switch": "off",
  "strict-fp/no-imperative-loops": "off",
  "strict-fp/no-let-or-var": "off",
  "strict-fp/max-function-lines": "off",
  "strict-fp/no-unnecessary-local-const": "off",
  "strict-fp/prefer-fp-ts-array-methods": "off",
  "strict-fp/prefer-function-composition": "off",
  "strict-fp/prefer-monadic-composition": "off",
  "strict-fp/prefer-monadic-error-handling": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/require-exhaustive-match": "off",
  "strict-fp/no-any-or-unknown": "off",
  "@typescript-eslint/no-deprecated": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

const testOverrideRules = {
  "strict-fp/max-function-lines": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-throw-outside-unsafe": "off",
  "strict-fp/no-let-or-var": "off",
  "strict-fp/prefer-monadic-error-handling": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

const createBoundaryConfig = (files: O.Option<ReadonlyArray<string>>) =>
  pipe(
    files,
    O.filter((f) => f.length > 0),
    O.match(
      () => [] as ReadonlyArray<TSESLint.FlatConfig.Config>,
      (f) => [{ name: "strict-fp/boundary-overrides", files: [...f], rules: boundaryOverrideRules }],
    ),
  );

const createTestConfig = (files: O.Option<ReadonlyArray<string>>) =>
  pipe(
    files,
    O.filter((f) => f.length > 0),
    O.match(
      () => [] as ReadonlyArray<TSESLint.FlatConfig.Config>,
      (f) => [{ name: "strict-fp/test-overrides", files: [...f], rules: testOverrideRules }],
    ),
  );

export const createStrictFpConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  ...(tseslint.configs.strictTypeChecked as ReadonlyArray<TSESLint.FlatConfig.Config>),
  {
    name: "strict-fp/recommended",
    files: options.files ? [...options.files] : ["**/*.ts", "**/*.tsx"],
    plugins: { "strict-fp": plugin },
    rules: strictFpRules(options.maxFunctionLines ?? 15),
  },
  ...createBoundaryConfig(O.fromNullable(options.boundaryFiles)),
  ...createTestConfig(O.fromNullable(options.testFiles)),
];

export const pluginMeta = {
  name: "@mye-org/eslint-plugin-strict-fp",
  version: "0.1.0",
} as const;

export const pluginRules = rules;
