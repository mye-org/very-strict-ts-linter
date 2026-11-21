import type { TSESLint } from "@typescript-eslint/utils";
import {
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
} as const;

export {
  configs,
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
};
