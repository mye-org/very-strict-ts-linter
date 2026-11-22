import type { TSESLint } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { pipe } from "fp-ts/lib/function.js";
import tseslint from "typescript-eslint";
import { rules } from "../rules/index.js";

export type LintTier = 1 | 2 | 3;

export type StrictFpConfigOptions = Partial<
  Record<"files" | "boundaryFiles" | "testFiles" | "domainFiles" | "applicationFiles", ReadonlyArray<string>> &
    Record<"maxFunctionLines", number> &
    Record<"maxTier", LintTier>
>;

export const defaultStrictFpFiles = ["**/*.ts"] as const;
export const defaultStrictFpIgnores = ["**/*.tsx", "**/*.config.ts"] as const;

export type PluginRuleName = keyof typeof rules;
export type RuleTier = LintTier | "react";

export const ruleTiers = {
  // Tier 1: Architecture & DDD
  "domain-layer-purity": 1,
  "no-cross-aggregate-reference": 1,
  "no-domain-raw-primitives": 1,
  "no-unit-suffixed-primitives": 1,
  "repository-aggregate-root-only": 1,
  "ubiquitous-language": 1,
  "no-data-clumps": 1,
  "no-external-entity-mutation": 1,
  "no-inline-infra-side-effects": 1,
  "no-lifecycle-flag-clusters": 1,
  "no-model-polysemy": 1,
  "no-multi-repo-orchestration": 1,
  "no-repeated-guard-clauses": 1,
  "no-scattered-validation": 1,
  "no-stringly-typed-discriminants": 1,
  "no-train-wreck-navigation": 1,

  // Tier 2: Type Safety & Correctness
  "no-any-or-unknown": 2,
  "no-explicit-return-type": 2,
  "no-null-undefined": 2,
  "no-optional-state-bags": 2,
  "parse-dont-validate": 2,
  "prefer-const-satisfies": 2,
  "prefer-exhaustive-record": 2,
  "prefer-nonempty-tuple": 2,
  "prefer-readonly-collections": 2,
  "prefer-template-literal-type": 2,
  "prefer-type-level-dispatch": 2,
  "prefer-type-over-interface": 2,
  "prefer-union-over-boolean": 2,
  "require-exhaustive-match": 2,
  "require-keyof-path": 2,

  // Tier 3: FP & Style
  "fp-ts-import-convention": 3,
  "max-function-lines": 3,
  "no-classes": 3,
  "no-fp-ts-chain": 3,
  "no-if-else-or-switch": 3,
  "no-imperative-loops": 3,
  "no-let-or-var": 3,
  "no-nested-pipe": 3,
  "no-nested-ternary": 3,
  "no-throw-outside-unsafe": 3,
  "no-unnecessary-local-const": 3,
  "prefer-fp-ts-array-methods": 3,
  "prefer-function-composition": 3,
  "prefer-monadic-composition": 3,
  "prefer-monadic-error-handling": 3,
  "prefer-point-free": 3,
  "single-level-of-abstraction": 3,

  // React preset
  "no-react-in-ts": "react",
  "thin-react-component": "react",
} as const satisfies Record<PluginRuleName, RuleTier>;

const buildRulesForTier = (tier: LintTier) =>
  pipe(
    RR.toEntries(ruleTiers),
    RA.filter(([, ruleTier]) => ruleTier === tier),
    RA.reduce<readonly [PluginRuleName, RuleTier], Record<string, TSESLint.FlatConfig.RuleEntry>>({}, (acc, [name]) => ({
      ...acc,
      [`strict-fp/${name}`]: "error",
    })),
  );

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

export const tier1Rules: TSESLint.FlatConfig.Rules = buildRulesForTier(1);

export const tier2Rules: TSESLint.FlatConfig.Rules = {
  ...buildRulesForTier(2),
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
  "@typescript-eslint/no-explicit-any": "off",
};

export const tier3Rules: TSESLint.FlatConfig.Rules = buildRulesForTier(3);

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

const buildTier1WithOverrides = (options: StrictFpConfigOptions) =>
  ({
    ...tier1Rules,
    ...(options.domainFiles
      ? { "strict-fp/domain-layer-purity": ["error", { domainPatterns: options.domainFiles }] as TSESLint.FlatConfig.RuleEntry }
      : {}),
    ...buildUbiquitousOptions(options),
  }) satisfies TSESLint.FlatConfig.Rules;

export const buildTieredRules = (maxTier: LintTier, maxLines = 15, options: StrictFpConfigOptions = {}) =>
  ({
    ...buildTier1WithOverrides(options),
    ...(maxTier >= 2 ? tier2Rules : {}),
    ...(maxTier >= 3
      ? { ...tier3Rules, "strict-fp/max-function-lines": ["error", { maxLines }] as TSESLint.FlatConfig.RuleEntry }
      : {}),
  }) satisfies TSESLint.FlatConfig.Rules;

export const strictFpRules = (maxLines = 15, options: StrictFpConfigOptions = {}) =>
  buildTieredRules(options.maxTier ?? 3, maxLines, options);

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
  "strict-fp/single-level-of-abstraction": "off",
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
  "strict-fp/single-level-of-abstraction": "off",
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

const resolveFiles = (options: StrictFpConfigOptions) =>
  options.files ? [...options.files] : [...defaultStrictFpFiles];

const scopeTypeCheckedConfigs = (files: ReadonlyArray<string>) =>
  pipe(
    tseslint.configs.strictTypeChecked as ReadonlyArray<TSESLint.FlatConfig.Config>,
    RA.map((cfg) => ({
      ...cfg,
      files: [...files],
      ignores: [...defaultStrictFpIgnores],
    })),
  );

export const createDddBoundaryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  {
    name: "strict-fp/ddd-boundary",
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
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
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
    plugins: { "strict-fp": plugin },
    rules: dddDiscoveryRules,
  },
];

const formatTierName = (maxTier: LintTier) => `strict-fp/tier-${String(maxTier)}`;

const createTierRuleBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  maxTier: LintTier,
  targetFiles: ReadonlyArray<string>,
  options: StrictFpConfigOptions,
) => ({
  name: formatTierName(maxTier),
  files: [...targetFiles],
  ignores: [...defaultStrictFpIgnores],
  plugins: { "strict-fp": plugin },
  rules: buildTieredRules(maxTier, options.maxFunctionLines ?? 15, options),
});

export const createTieredConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => [
  ...((options.maxTier ?? 3) >= 2 ? scopeTypeCheckedConfigs(resolveFiles(options)) : []),
  createTierRuleBlock(plugin, options.maxTier ?? 3, resolveFiles(options), options),
  ...createBoundaryConfig(O.fromNullable(options.boundaryFiles)),
  ...createTestConfig(O.fromNullable(options.testFiles)),
];

export const createStrictFpConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => createTieredConfig(plugin, { ...options, maxTier: options.maxTier ?? 3 });

export type StrictReactConfigOptions = Partial<
  Record<"tsFiles" | "tsxFiles" | "ignores", ReadonlyArray<string>>
>;

export const reactTsRules = {
  "strict-fp/no-react-in-ts": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

export const reactTsxRules = {
  "strict-fp/thin-react-component": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

const defaultReactTsxIgnores = [
  "**/*.test.tsx",
  "**/*.spec.tsx",
  "**/*.stories.tsx",
] as const;

const createReactTsBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions,
) => ({
  name: "strict-fp/react-ts-boundary",
  files: options.tsFiles ? [...options.tsFiles] : ["**/*.ts"],
  ignores: [...defaultStrictFpIgnores],
  plugins: { "strict-fp": plugin },
  rules: reactTsRules,
});

const createReactTsxBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions,
) => ({
  name: "strict-fp/react-thin-tsx",
  files: options.tsxFiles ? [...options.tsxFiles] : ["**/*.tsx"],
  ignores: options.ignores ? [...options.ignores] : [...defaultReactTsxIgnores],
  plugins: { "strict-fp": plugin },
  rules: reactTsxRules,
});

export const createStrictReactConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions = {},
) => [
  createReactTsBlock(plugin, options),
  createReactTsxBlock(plugin, options),
];

export const pluginMeta = {
  name: "@mye-org/eslint-plugin-strict-fp",
  version: "0.1.0",
} as const;

export const pluginRules = rules;
