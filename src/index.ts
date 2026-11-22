import type { TSESLint } from "@typescript-eslint/utils";
import {
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createStrictFpConfig,
  createTieredConfig,
  pluginMeta,
  pluginRules,
  tier1Rules,
  tier2Rules,
  tier3Rules,
  type LintTier,
  type StrictFpConfigOptions,
} from "./configs/recommended.js";

const plugin: TSESLint.FlatConfig.Plugin = {
  meta: pluginMeta,
  rules: pluginRules,
};

const configs = {
  recommended: createStrictFpConfig(plugin),
  tier1: createTieredConfig(plugin, { maxTier: 1 }),
  tier2: createTieredConfig(plugin, { maxTier: 2 }),
  tier3: createTieredConfig(plugin, { maxTier: 3 }),
  dddBoundary: createDddBoundaryConfig(plugin),
  dddDiscovery: createDddDiscoveryConfig(plugin),
} as const;

export {
  configs,
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createStrictFpConfig,
  createTieredConfig,
  pluginRules as rules,
  tier1Rules,
  tier2Rules,
  tier3Rules,
  type LintTier,
  type StrictFpConfigOptions,
};

export default {
  meta: pluginMeta,
  rules: pluginRules,
  configs,
  createStrictFpConfig: (options?: StrictFpConfigOptions) =>
    createStrictFpConfig(plugin, options),
  createTieredConfig: (options?: StrictFpConfigOptions) =>
    createTieredConfig(plugin, options),
  createDddBoundaryConfig: (options?: StrictFpConfigOptions) =>
    createDddBoundaryConfig(plugin, options),
  createDddDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    createDddDiscoveryConfig(plugin, options),
};
