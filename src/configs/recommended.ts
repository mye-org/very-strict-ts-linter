import type { TSESLint } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import tseslint from "typescript-eslint";
import { rules } from "../rules/index.js";

export type StrictFpConfigOptions = Partial<
  Record<"files" | "boundaryFiles" | "testFiles" | "domainFiles" | "applicationFiles", ReadonlyArray<string>> &
    Record<"maxFunctionLines", number>
>;

export const dddBoundaryRules = {
  "strict-fp/domain-layer-purity": "error",
  "strict-fp/no-cross-aggregate-reference": "error",
  "strict-fp/no-domain-raw-primitives": "error",
  "strict-fp/no-unit-suffixed-primitives": "error",
  "strict-fp/repository-aggregate-root-only": "error",
  "strict-fp/ubiquitous-language": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

export const dddDiscoveryRules = {
  "strict-fp/no-data-clumps": "error",
  "strict-fp/no-external-entity-mutation": "error",
  "strict-fp/no-inline-infra-side-effects": "error",
  "strict-fp/no-lifecycle-flag-clusters": "error",
  "strict-fp/no-model-polysemy": "error",
  "strict-fp/no-multi-repo-orchestration": "error",
  "strict-fp/no-repeated-guard-clauses": "error",
  "strict-fp/no-scattered-validation": "error",
  "strict-fp/no-stringly-typed-discriminants": "error",
  "strict-fp/no-train-wreck-navigation": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

const baseStrictFpRules = {
  ...dddBoundaryRules,
  ...dddDiscoveryRules,
  "strict-fp/fp-ts-import-convention": "error",
  "strict-fp/no-any-or-unknown": "error",
  "strict-fp/no-classes": "error",
  "strict-fp/no-explicit-return-type": "error",
  "strict-fp/no-fp-ts-chain": "error",
  "strict-fp/no-if-else-or-switch": "error",
  "strict-fp/no-imperative-loops": "error",
  "strict-fp/no-let-or-var": "error",
  "strict-fp/no-nested-pipe": "error",
  "strict-fp/no-nested-ternary": "error",
  "strict-fp/no-null-undefined": "error",
  "strict-fp/no-optional-state-bags": "error",
  "strict-fp/no-throw-outside-unsafe": "error",
  "strict-fp/no-unnecessary-local-const": "error",
  "strict-fp/parse-dont-validate": "error",
  "strict-fp/prefer-const-satisfies": "error",
  "strict-fp/prefer-exhaustive-record": "error",
  "strict-fp/prefer-fp-ts-array-methods": "error",
  "strict-fp/prefer-function-composition": "error",
  "strict-fp/prefer-monadic-composition": "error",
  "strict-fp/prefer-monadic-error-handling": "error",
  "strict-fp/prefer-nonempty-tuple": "error",
  "strict-fp/prefer-point-free": "error",
  "strict-fp/prefer-readonly-collections": "error",
  "strict-fp/prefer-template-literal-type": "error",
  "strict-fp/prefer-type-level-dispatch": "error",
  "strict-fp/prefer-type-over-interface": "error",
  "strict-fp/prefer-union-over-boolean": "error",
  "strict-fp/require-exhaustive-match": "error",
  "strict-fp/require-keyof-path": "error",
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
  "@typescript-eslint/no-explicit-any": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

const buildUbiquitousOptions = (options: StrictFpConfigOptions) =>
  options.domainFiles || options.applicationFiles
    ? {
        "strict-fp/ubiquitous-language": [
          "error",
          {
            domainPatterns: [
              ...(options.domainFiles ?? ["**/domain/**", "**/domains/**"]),
              ...(options.applicationFiles ?? ["**/application/**"]),
            ],
          },
        ] as TSESLint.FlatConfig.RuleEntry,
      }
    : {};

export const strictFpRules = (maxLines = 15, options: StrictFpConfigOptions = {}) =>
  ({
    ...baseStrictFpRules,
    "strict-fp/max-function-lines": ["error", { maxLines }],
    ...(options.domainFiles
      ? { "strict-fp/domain-layer-purity": ["error", { domainPatterns: options.domainFiles }] as TSESLint.FlatConfig.RuleEntry }
      : {}),
    ...buildUbiquitousOptions(options),
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
  "strict-fp/prefer-point-free": "off",
  "strict-fp/no-nested-pipe": "off",
  "strict-fp/no-fp-ts-chain": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/no-unit-suffixed-primitives": "off",
  "strict-fp/no-scattered-validation": "off",
  "strict-fp/no-inline-infra-side-effects": "off",
  "strict-fp/no-multi-repo-orchestration": "off",
  "strict-fp/domain-layer-purity": "off",
  "strict-fp/no-optional-state-bags": "off",
  "strict-fp/parse-dont-validate": "off",
  "strict-fp/prefer-exhaustive-record": "off",
  "strict-fp/prefer-nonempty-tuple": "off",
  "strict-fp/prefer-template-literal-type": "off",
  "strict-fp/prefer-type-level-dispatch": "off",
  "strict-fp/prefer-union-over-boolean": "off",
  "strict-fp/require-exhaustive-match": "off",
  "strict-fp/require-keyof-path": "off",
  "strict-fp/no-any-or-unknown": "off",
  "@typescript-eslint/no-deprecated": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

const testOverrideRules = {
  "strict-fp/max-function-lines": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/no-unit-suffixed-primitives": "off",
  "strict-fp/no-data-clumps": "off",
  "strict-fp/no-scattered-validation": "off",
  "strict-fp/no-stringly-typed-discriminants": "off",
  "strict-fp/no-repeated-guard-clauses": "off",
  "strict-fp/no-lifecycle-flag-clusters": "off",
  "strict-fp/no-model-polysemy": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-optional-state-bags": "off",
  "strict-fp/parse-dont-validate": "off",
  "strict-fp/prefer-exhaustive-record": "off",
  "strict-fp/prefer-nonempty-tuple": "off",
  "strict-fp/prefer-template-literal-type": "off",
  "strict-fp/prefer-type-level-dispatch": "off",
  "strict-fp/prefer-union-over-boolean": "off",
  "strict-fp/no-throw-outside-unsafe": "off",
  "strict-fp/no-let-or-var": "off",
  "strict-fp/prefer-monadic-error-handling": "off",
  "strict-fp/require-keyof-path": "off",
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

export const createDddBoundaryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  {
    name: "strict-fp/ddd-boundary",
    files: options.files ? [...options.files] : ["**/*.ts", "**/*.tsx"],
    plugins: { "strict-fp": plugin },
    rules: dddBoundaryRules,
  },
];

export const createDddDiscoveryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  {
    name: "strict-fp/ddd-discovery",
    files: options.files ? [...options.files] : ["**/*.ts", "**/*.tsx"],
    plugins: { "strict-fp": plugin },
    rules: dddDiscoveryRules,
  },
];

export const createStrictFpConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  ...(tseslint.configs.strictTypeChecked as ReadonlyArray<TSESLint.FlatConfig.Config>),
  {
    name: "strict-fp/recommended",
    files: options.files ? [...options.files] : ["**/*.ts", "**/*.tsx"],
    plugins: { "strict-fp": plugin },
    rules: strictFpRules(options.maxFunctionLines ?? 15, options),
  },
  ...createBoundaryConfig(O.fromNullable(options.boundaryFiles)),
  ...createTestConfig(O.fromNullable(options.testFiles)),
];

export const pluginMeta = {
  name: "@mye-org/eslint-plugin-strict-fp",
  version: "0.1.0",
} as const;

export const pluginRules = rules;
