import type { TSESLint } from "@typescript-eslint/utils";
import {
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createStrictFpConfig,
  pluginMeta,
  pluginRules,
  type StrictFpConfigOptions,
} from "./configs/recommended.js";

const plugin: TSESLint.FlatConfig.Plugin = {
  meta: pluginMeta,
  rules: pluginRules,
};

const configs = {
  recommended: createStrictFpConfig(plugin),
  dddBoundary: createDddBoundaryConfig(plugin),
  dddDiscovery: createDddDiscoveryConfig(plugin),
} as const;

export {
  configs,
  createDddBoundaryConfig,
  createDddDiscoveryConfig,
  createStrictFpConfig,
  pluginRules as rules,
  type StrictFpConfigOptions,
};

export default {
  meta: pluginMeta,
  rules: pluginRules,
  configs,
  createStrictFpConfig: (options?: StrictFpConfigOptions) =>
    createStrictFpConfig(plugin, options),
  createDddBoundaryConfig: (options?: StrictFpConfigOptions) =>
    createDddBoundaryConfig(plugin, options),
  createDddDiscoveryConfig: (options?: StrictFpConfigOptions) =>
    createDddDiscoveryConfig(plugin, options),
};
