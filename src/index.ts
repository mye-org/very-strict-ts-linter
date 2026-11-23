import type { TSESLint } from "@typescript-eslint/utils";
import {
  buildDddBoundaryConfig,
  buildDddDiscoveryConfig,
  buildFpDiscoveryConfig,
  buildStrictFpConfig,
  buildStrictReactConfig,
  buildTestScopeConfig,
  buildTieredConfig,
  defaultStrictFpFiles,
  defaultStrictFpIgnores,
  reactTsRules,
  reactTsxRules,
  ruleTiers,
  testScopeRules,
  tier1Rules,
  tier2Rules,
  tier3Rules,
  type LintTier,
  type PluginRuleName,
  type PluginRuleTier,
  type StrictFpConfigOptions,
  type StrictReactConfigOptions,
} from "./configs/recommended.js";
import { tier0TypeChecker } from "./configs/tier0.js";
import { rules } from "./rules/index.js";

const pluginMeta = {
  name: "@mye-org/eslint-plugin-strict-fp",
  version: "0.1.0",
} as const;

const pluginRules = rules;

const plugin: TSESLint.FlatConfig.Plugin = {
  meta: pluginMeta,
  rules: pluginRules,
};

const configs = {
  recommended: buildStrictFpConfig(plugin),
  tier0: buildTieredConfig(plugin, { maxTier: 0 }),
  tier1: buildTieredConfig(plugin, { maxTier: 1 }),
  tier2: buildTieredConfig(plugin, { maxTier: 2 }),
  tier3: buildTieredConfig(plugin, { maxTier: 3 }),
  dddBoundary: buildDddBoundaryConfig(plugin),
  dddDiscovery: buildDddDiscoveryConfig(plugin),
  fpDiscovery: buildFpDiscoveryConfig(plugin),
  testScope: buildTestScopeConfig(plugin),
  react: buildStrictReactConfig(plugin),
} as const;

export { rules } from "./rules/index.js";

export {
  configs,
  buildDddBoundaryConfig as createDddBoundaryConfig,
  buildDddDiscoveryConfig as createDddDiscoveryConfig,
  buildFpDiscoveryConfig as createFpDiscoveryConfig,
  buildStrictFpConfig as createStrictFpConfig,
  buildStrictReactConfig as createStrictReactConfig,
  buildTestScopeConfig as createTestScopeConfig,
  buildTieredConfig as createTieredConfig,
  defaultStrictFpFiles,
  defaultStrictFpIgnores,
  reactTsRules,
  reactTsxRules,
  ruleTiers,
  testScopeRules,
  tier0TypeChecker,
  tier1Rules,
  tier2Rules,
  tier3Rules,
  type LintTier,
  type PluginRuleName,
  type PluginRuleTier,
  type StrictFpConfigOptions,
  type StrictReactConfigOptions,
};

type StrictFpPlugin = Readonly<{
  meta: typeof pluginMeta;
  rules: typeof pluginRules;
  configs: typeof configs;
  createStrictFpConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createStrictReactConfig: (options?: StrictReactConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createTieredConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createDddBoundaryConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createDddDiscoveryConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createFpDiscoveryConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
  createTestScopeConfig: (options?: StrictFpConfigOptions) => TSESLint.FlatConfig.ConfigArray;
}>;

const strictFpPlugin: StrictFpPlugin = {
  meta: pluginMeta,
  rules: pluginRules,
  configs,
  createStrictFpConfig: (options) => buildStrictFpConfig(plugin, options),
  createStrictReactConfig: (options) => buildStrictReactConfig(plugin, options),
  createTieredConfig: (options) => buildTieredConfig(plugin, options),
  createDddBoundaryConfig: (options) => buildDddBoundaryConfig(plugin, options),
  createDddDiscoveryConfig: (options) => buildDddDiscoveryConfig(plugin, options),
  createFpDiscoveryConfig: (options) => buildFpDiscoveryConfig(plugin, options),
  createTestScopeConfig: (options) => buildTestScopeConfig(plugin, options),
};

export default strictFpPlugin;
