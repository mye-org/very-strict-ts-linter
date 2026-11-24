import type { TSESLint } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as RA from "fp-ts/lib/ReadonlyArray.js";
import * as RR from "fp-ts/lib/ReadonlyRecord.js";
import { flow } from "fp-ts/lib/function.js";
import tseslint from "typescript-eslint";
import type { rules } from "../rules/index.js";

export type PluginRuleTier = 1 | 2 | 3;
export type LintTier = 0 | PluginRuleTier;

export type StrictFpConfigOptions = Partial<
  Record<
    "files" | "boundaryFiles" | "testFiles" | "domainFiles" | "applicationFiles" | "entryPoints",
    ReadonlyArray<string>
  > &
    Record<"maxTier", LintTier>
>;

export const defaultStrictFpFiles = ["**/*.ts"] as const;
export const defaultStrictFpIgnores = ["**/*.tsx", "**/*.config.ts"] as const;

export type PluginRuleName = keyof typeof rules;

export const ruleTiers = {
  // Tier 1: Type Safety & Correctness
  "no-any-or-unknown": 1,
  "no-explicit-return-type": 1,
  "no-null-undefined": 1,
  "no-optional-state-bags": 1,
  "parse-dont-validate": 1,
  "prefer-const-satisfies": 1,
  "prefer-exhaustive-record": 1,
  "prefer-nonempty-tuple": 1,
  "prefer-readonly-collections": 1,
  "prefer-template-literal-type": 1,
  "prefer-type-level-dispatch": 1,
  "prefer-type-over-interface": 1,
  "prefer-union-over-boolean": 1,
  "require-exhaustive-match": 1,
  "require-keyof-path": 1,

  // Tier 2: Architecture & DDD
  "common-reuse-cohesion": 2,
  "domain-layer-purity": 2,
  "functional-core-boundary": 2,
  "max-function-params": 2,
  "module-cohesion": 2,
  "no-cross-aggregate-reference": 2,
  "no-domain-raw-primitives": 2,
  "no-generic-utility-names": 2,
  "no-react-in-ts": 2,
  "no-single-caller-export": 2,
  "no-unit-suffixed-primitives": 2,
  "no-unsafe-react-hooks": 2,
  "repository-aggregate-root-only": 2,
  "require-js-thread-schedule-on-rn": 2,
  "thin-react-component": 2,
  "ubiquitous-language": 2,
  "no-data-clumps": 2,
  "no-external-entity-mutation": 2,
  "no-inline-infra-side-effects": 2,
  "no-lifecycle-flag-clusters": 2,
  "no-model-polysemy": 2,
  "no-multi-repo-orchestration": 2,
  "no-repeated-guard-clauses": 2,
  "no-scattered-validation": 2,
  "no-stringly-typed-discriminants": 2,
  "no-structural-skeleton-duplication": 2,
  "no-train-wreck-navigation": 2,
  "no-redundant-test-scope": 2,
  "prefer-catamorphism-over-recursive-adt-walk": 2,
  "prefer-lowest-test-level": 2,
  "prefer-reader-over-context-drilling": 2,
  "single-test-responsibility": 2,

  // Tier 3: FP & Style
  "fp-ts-import-convention": 3,
  "no-async-await": 3,
  "no-classes": 3,
  "no-fp-ts-chain": 3,
  "no-fp-ts-hkt": 3,
  "no-fp-ts-pipe": 3,
  "no-if-else-or-switch": 3,
  "no-imperative-loops": 3,
  "no-let-or-var": 3,
  "no-mutation": 3,
  "no-nested-pipe": 3,
  "no-nested-ternary": 3,
  "no-throw-outside-unsafe": 3,
  "no-unnecessary-local-const": 3,
  "prefer-applicative-over-independent-bind": 3,
  "prefer-expressive-ts-pattern": 3,
  "prefer-fp-ts-array-methods": 3,
  "prefer-function-composition": 3,
  "prefer-functor-fusion": 3,
  "prefer-lens-over-nested-spread": 3,
  "prefer-monadic-composition": 3,
  "prefer-monadic-error-handling": 3,
  "prefer-point-free": 3,
  "prefer-prism-over-guarded-update": 3,
  "prefer-traversal-over-nested-collection-update": 3,
  "prefer-traverse-over-map-sequence": 3,
  "single-level-of-abstraction": 3,
} as const satisfies Record<PluginRuleName, PluginRuleTier>;

const filterRulesByTier = (tier: PluginRuleTier) =>
  flow(
    RR.toEntries<PluginRuleName, PluginRuleTier>,
    RA.filter(([, ruleTier]) => ruleTier === tier),
    RA.reduce<readonly [PluginRuleName, PluginRuleTier], Record<string, TSESLint.FlatConfig.RuleEntry>>(
      {},
      (acc, [name]) => ({
        ...acc,
        [`strict-fp/${name}`]: "error",
      }),
    ),
  );

const buildRulesForTier = (tier: PluginRuleTier) => filterRulesByTier(tier)(ruleTiers);

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

export const fpDiscoveryRules = {
  "strict-fp/no-structural-skeleton-duplication": "error",
  "strict-fp/prefer-catamorphism-over-recursive-adt-walk": "error",
  "strict-fp/prefer-reader-over-context-drilling": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

export const testScopeRules = {
  "strict-fp/no-redundant-test-scope": "error",
  "strict-fp/prefer-lowest-test-level": "error",
  "strict-fp/single-test-responsibility": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

export const tier1Rules: TSESLint.FlatConfig.Rules = {
  ...buildRulesForTier(1),
  "no-sequences": "error",
  "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
  "@typescript-eslint/explicit-module-boundary-types": "error",
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
  "@typescript-eslint/no-unnecessary-type-parameters": "off",
};

export const tier2Rules: TSESLint.FlatConfig.Rules = buildRulesForTier(2);

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
        ] satisfies TSESLint.FlatConfig.RuleEntry,
      }
    : {};

const buildSingleCallerExportOption = (options: StrictFpConfigOptions) =>
  options.entryPoints || options.testFiles
    ? {
        "strict-fp/no-single-caller-export": [
          "error",
          {
            ...(options.entryPoints ? { entryPoints: options.entryPoints } : {}),
            ...(options.testFiles ? { testPatterns: options.testFiles } : {}),
          },
        ] satisfies TSESLint.FlatConfig.RuleEntry,
      }
    : {};

const buildCommonReuseOption = (options: StrictFpConfigOptions) =>
  options.testFiles
    ? {
        "strict-fp/common-reuse-cohesion": [
          "error",
          { testPatterns: options.testFiles },
        ] satisfies TSESLint.FlatConfig.RuleEntry,
      }
    : {};

const buildModuleArchitectureOptions = (options: StrictFpConfigOptions) => ({
  ...buildSingleCallerExportOption(options),
  ...buildCommonReuseOption(options),
});

const buildTestPatternEntry = (testFiles: ReadonlyArray<string>) =>
  ["error", { testPatterns: testFiles }] satisfies TSESLint.FlatConfig.RuleEntry;

const buildTestScopeOptions = (options: StrictFpConfigOptions) =>
  options.testFiles
    ? {
        "strict-fp/no-redundant-test-scope": buildTestPatternEntry(options.testFiles),
        "strict-fp/prefer-lowest-test-level": buildTestPatternEntry(options.testFiles),
        "strict-fp/single-test-responsibility": buildTestPatternEntry(options.testFiles),
      }
    : {};

const buildTier2WithOverrides = (options: StrictFpConfigOptions) =>
  ({
    ...tier2Rules,
    ...(options.domainFiles
      ? { "strict-fp/domain-layer-purity": ["error", { domainPatterns: options.domainFiles }] satisfies TSESLint.FlatConfig.RuleEntry }
      : {}),
    ...buildUbiquitousOptions(options),
    ...buildModuleArchitectureOptions(options),
    ...buildTestScopeOptions(options),
  }) satisfies TSESLint.FlatConfig.Rules;

export const buildTieredRules = (
  maxTier: LintTier,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.Rules => ({
  ...(maxTier >= 1 ? tier1Rules : {}),
  ...(maxTier >= 2 ? buildTier2WithOverrides(options) : {}),
  ...(maxTier >= 3 ? tier3Rules : {}),
});

export const strictFpRules = (options: StrictFpConfigOptions = {}): TSESLint.FlatConfig.Rules =>
  buildTieredRules(options.maxTier ?? 3, options);

const boundaryOverrideRules = {
  "strict-fp/functional-core-boundary": "off",
  "strict-fp/no-throw-outside-unsafe": "off",
  "strict-fp/no-if-else-or-switch": "off",
  "strict-fp/no-imperative-loops": "off",
  "strict-fp/no-let-or-var": "off",
  "strict-fp/no-mutation": "off",
  "strict-fp/no-classes": "off",
  "strict-fp/no-nested-ternary": "off",
  "strict-fp/max-function-params": "off",
  "strict-fp/no-unnecessary-local-const": "off",
  "strict-fp/prefer-applicative-over-independent-bind": "off",
  "strict-fp/prefer-expressive-ts-pattern": "off",
  "strict-fp/prefer-fp-ts-array-methods": "off",
  "strict-fp/prefer-function-composition": "off",
  "strict-fp/prefer-functor-fusion": "off",
  "strict-fp/prefer-lens-over-nested-spread": "off",
  "strict-fp/prefer-monadic-composition": "off",
  "strict-fp/prefer-monadic-error-handling": "off",
  "strict-fp/no-async-await": "off",
  "strict-fp/prefer-point-free": "off",
  "strict-fp/prefer-prism-over-guarded-update": "off",
  "strict-fp/prefer-traversal-over-nested-collection-update": "off",
  "strict-fp/prefer-traverse-over-map-sequence": "off",
  "strict-fp/single-level-of-abstraction": "off",
  "strict-fp/no-nested-pipe": "off",
  "strict-fp/no-fp-ts-chain": "off",
  "strict-fp/no-fp-ts-pipe": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/no-unit-suffixed-primitives": "off",
  "strict-fp/no-scattered-validation": "off",
  "strict-fp/no-inline-infra-side-effects": "off",
  "strict-fp/no-multi-repo-orchestration": "off",
  "strict-fp/no-external-entity-mutation": "off",
  "strict-fp/no-train-wreck-navigation": "off",
  "strict-fp/no-lifecycle-flag-clusters": "off",
  "strict-fp/no-stringly-typed-discriminants": "off",
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
  "strict-fp/common-reuse-cohesion": "off",
  "strict-fp/functional-core-boundary": "off",
  "strict-fp/module-cohesion": "off",
  "strict-fp/no-single-caller-export": "off",
  "strict-fp/no-mutation": "off",
  "strict-fp/max-function-params": "off",
  "strict-fp/no-any-or-unknown": "off",
  "strict-fp/no-classes": "off",
  "strict-fp/no-if-else-or-switch": "off",
  "strict-fp/no-imperative-loops": "off",
  "strict-fp/no-nested-ternary": "off",
  "strict-fp/no-unnecessary-local-const": "off",
  "strict-fp/no-fp-ts-chain": "off",
  "strict-fp/no-fp-ts-pipe": "off",
  "strict-fp/no-nested-pipe": "off",
  "strict-fp/no-domain-raw-primitives": "off",
  "strict-fp/no-unit-suffixed-primitives": "off",
  "strict-fp/no-data-clumps": "off",
  "strict-fp/no-external-entity-mutation": "off",
  "strict-fp/no-inline-infra-side-effects": "off",
  "strict-fp/no-multi-repo-orchestration": "off",
  "strict-fp/no-train-wreck-navigation": "off",
  "strict-fp/no-scattered-validation": "off",
  "strict-fp/no-stringly-typed-discriminants": "off",
  "strict-fp/no-structural-skeleton-duplication": "off",
  "strict-fp/no-repeated-guard-clauses": "off",
  "strict-fp/no-lifecycle-flag-clusters": "off",
  "strict-fp/no-model-polysemy": "off",
  "strict-fp/no-null-undefined": "off",
  "strict-fp/no-optional-state-bags": "off",
  "strict-fp/parse-dont-validate": "off",
  "strict-fp/prefer-catamorphism-over-recursive-adt-walk": "off",
  "strict-fp/prefer-exhaustive-record": "off",
  "strict-fp/prefer-nonempty-tuple": "off",
  "strict-fp/prefer-reader-over-context-drilling": "off",
  "strict-fp/prefer-template-literal-type": "off",
  "strict-fp/prefer-type-level-dispatch": "off",
  "strict-fp/prefer-union-over-boolean": "off",
  "strict-fp/no-throw-outside-unsafe": "off",
  "strict-fp/no-let-or-var": "off",
  "strict-fp/prefer-monadic-error-handling": "off",
  "strict-fp/no-async-await": "off",
  "strict-fp/require-keyof-path": "off",
  "strict-fp/single-level-of-abstraction": "off",
} as const satisfies TSESLint.FlatConfig.Rules;

const buildBoundaryConfig = flow(
  O.filter((f: ReadonlyArray<string>) => f.length > 0),
  O.match(
    () => [] satisfies ReadonlyArray<TSESLint.FlatConfig.Config>,
    (f) => [{ name: "strict-fp/boundary-overrides", files: [...f], rules: boundaryOverrideRules }],
  ),
);

const buildTestConfig = flow(
  O.filter((f: ReadonlyArray<string>) => f.length > 0),
  O.match(
    () => [] satisfies ReadonlyArray<TSESLint.FlatConfig.Config>,
    (f) => [{ name: "strict-fp/test-overrides", files: [...f], rules: testOverrideRules }],
  ),
);

const resolveFiles = (options: StrictFpConfigOptions) =>
  options.files ? [...options.files] : [...defaultStrictFpFiles];

const scopeTypeCheckedConfigs = (files: ReadonlyArray<string>) =>
  RA.map((cfg: TSESLint.FlatConfig.Config) => ({
    ...cfg,
    files: [...files],
    ignores: [...defaultStrictFpIgnores],
  }))(tseslint.configs.strictTypeChecked);

export const buildDddBoundaryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => [
  {
    name: "strict-fp/ddd-boundary",
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
    plugins: { "strict-fp": plugin },
    rules: dddBoundaryRules,
  },
];

export const buildDddDiscoveryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => [
  {
    name: "strict-fp/ddd-discovery",
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
    plugins: { "strict-fp": plugin },
    rules: dddDiscoveryRules,
  },
];

export const buildFpDiscoveryConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => [
  {
    name: "strict-fp/fp-discovery",
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
    plugins: { "strict-fp": plugin },
    rules: fpDiscoveryRules,
  },
];

export const buildTestScopeConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => [
  {
    name: "strict-fp/test-scope",
    files: resolveFiles(options),
    ignores: [...defaultStrictFpIgnores],
    plugins: { "strict-fp": plugin },
    rules: {
      ...testScopeRules,
      ...buildTestScopeOptions(options),
    },
  },
];

const formatTierName = (maxTier: LintTier) => `strict-fp/tier-${String(maxTier)}`;

const buildTierRuleBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions,
) => ({
  name: formatTierName(options.maxTier ?? 3),
  files: [...resolveFiles(options)],
  ignores: [...defaultStrictFpIgnores],
  plugins: { "strict-fp": plugin },
  rules: buildTieredRules(options.maxTier ?? 3, options),
});

export type StrictReactConfigOptions = Partial<
  Record<"tsFiles" | "tsxFiles" | "ignores", ReadonlyArray<string>>
>;

export const reactTsRules = {
  "strict-fp/no-react-in-ts": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

export const reactTsxRules = {
  "no-sequences": "error",
  "strict-fp/no-unsafe-react-hooks": "error",
  "strict-fp/require-js-thread-schedule-on-rn": "error",
  "strict-fp/thin-react-component": "error",
} as const satisfies TSESLint.FlatConfig.Rules;

const defaultReactTsxIgnores = [
  "**/*.test.tsx",
  "**/*.spec.tsx",
  "**/*.stories.tsx",
] as const;

const buildReactTsBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions,
) => ({
  name: "strict-fp/react-ts-boundary",
  files: options.tsFiles ? [...options.tsFiles] : ["**/*.ts"],
  ignores: [...defaultStrictFpIgnores],
  plugins: { "strict-fp": plugin },
  rules: reactTsRules,
});

const buildReactTsxBlock = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions,
) => ({
  name: "strict-fp/react-thin-tsx",
  files: options.tsxFiles ? [...options.tsxFiles] : ["**/*.tsx"],
  ignores: options.ignores ? [...options.ignores] : [...defaultReactTsxIgnores],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
  plugins: { "strict-fp": plugin },
  rules: reactTsxRules,
});

export const buildTieredConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => {
  const maxTier = options.maxTier ?? 3;
  return [
    ...(maxTier >= 1 ? scopeTypeCheckedConfigs(resolveFiles(options)) : []),
    buildTierRuleBlock(plugin, options),
    ...(maxTier >= 2 ? [buildReactTsxBlock(plugin, {})] : []),
    ...buildBoundaryConfig(O.fromNullable(options.boundaryFiles)),
    ...buildTestConfig(O.fromNullable(options.testFiles)),
  ];
};

export const buildStrictFpConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray =>
  buildTieredConfig(plugin, { ...options, maxTier: options.maxTier ?? 3 });

export const buildStrictReactConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictReactConfigOptions = {},
): TSESLint.FlatConfig.ConfigArray => [
  buildReactTsBlock(plugin, options),
  buildReactTsxBlock(plugin, options),
];
