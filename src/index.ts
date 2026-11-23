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

export default {
  meta: pluginMeta,
  rules: pluginRules,
  configs,
  createStrictFpConfig: (options?: StrictFpConfigOptions) =>
    buildStrictFpConfig(plugin, options),
  createStrictReactConfig: (options?: StrictReactConfigOptions) =>
    buildStrictReactConfig(plugin, options),
  createTieredConfig: (options?: StrictFpConfigOptions) =>
    buildTieredConfig(plugin, options),
  createDddBoundaryConfig: (options?: StrictFpConfigOptions) =>
    buildDddBoundaryConfig(plugin, options),
  createDddDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    buildDddDiscoveryConfig(plugin, options),
  createFpDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    buildFpDiscoveryConfig(plugin, options),
  createTestScopeConfig: (options?: StrictFpConfigOptions) =>
    buildTestScopeConfig(plugin, options),
};
