import type { TSESLint } from "@typescript-eslint/utils";
import {
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createFpDiscoveryConfig,
  createStrictFpConfig,
  createStrictReactConfig,
  createTestScopeConfig,
  createTieredConfig,
  pluginMeta,
  pluginRules,
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
} from "./configs/recommended.js";

const plugin: TSESLint.FlatConfig.Plugin = {
  meta: pluginMeta,
  rules: pluginRules,
};

const configs = {
  recommended: createStrictFpConfig(plugin),
  tier0: createTieredConfig(plugin, { maxTier: 0 }),
  tier1: createTieredConfig(plugin, { maxTier: 1 }),
  tier2: createTieredConfig(plugin, { maxTier: 2 }),
  tier3: createTieredConfig(plugin, { maxTier: 3 }),
  dddBoundary: createDddBoundaryConfig(plugin),
  dddDiscovery: createDddDiscoveryConfig(plugin),
  fpDiscovery: createFpDiscoveryConfig(plugin),
  testScope: createTestScopeConfig(plugin),
  react: createStrictReactConfig(plugin),
} as const;

export {
  configs,
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createFpDiscoveryConfig,
  createStrictFpConfig,
  createStrictReactConfig,
  createTestScopeConfig,
  createTieredConfig,
  pluginRules as rules,
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

export default {
  meta: pluginMeta,
  rules: pluginRules,
  configs,
  createStrictFpConfig: (options?: StrictFpConfigOptions) =>
    createStrictFpConfig(plugin, options),
  createStrictReactConfig: (options?: StrictReactConfigOptions) =>
    createStrictReactConfig(plugin, options),
  createTieredConfig: (options?: StrictFpConfigOptions) =>
    createTieredConfig(plugin, options),
  createDddBoundaryConfig: (options?: StrictFpConfigOptions) =>
    createDddBoundaryConfig(plugin, options),
  createDddDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    createDddDiscoveryConfig(plugin, options),
  createFpDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    createFpDiscoveryConfig(plugin, options),
  createTestScopeConfig: (options?: StrictFpConfigOptions) =>
    createTestScopeConfig(plugin, options),
};
