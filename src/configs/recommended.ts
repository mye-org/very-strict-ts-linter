import type { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";
import { rules } from "../rules/index.js";

export type StrictFpConfigOptions = {
  readonly files?: ReadonlyArray<string>;
  readonly boundaryFiles?: ReadonlyArray<string>;
  readonly testFiles?: ReadonlyArray<string>;
  readonly maxFunctionLines?: number;
};

export const strictFpRules = (maxLines = 15) => ({
  "strict-fp/fp-ts-import-convention": "error",
  "strict-fp/max-function-lines": ["error", { maxLines }],
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
  "strict-fp/prefer-readonly-collections": "error",
  "strict-fp/prefer-type-over-interface": "error",
  "strict-fp/require-exhaustive-match": "error",
  // Disable overlapping @typescript-eslint rules that conflict with our custom rules
  "@typescript-eslint/consistent-type-definitions": ["error", "type"],
  "@typescript-eslint/no-explicit-any": "off",
} satisfies TSESLint.FlatConfig.Rules);

export const createStrictFpConfig = (
  plugin: TSESLint.FlatConfig.Plugin,
  options: StrictFpConfigOptions = {},
) => {
  const files = options.files ? [...options.files] : ["**/*.ts", "**/*.tsx"];
  const maxLines = options.maxFunctionLines ?? 15;

  const baseConfigs: ReadonlyArray<TSESLint.FlatConfig.Config> = [
    ...(tseslint.configs.strictTypeChecked as ReadonlyArray<TSESLint.FlatConfig.Config>),
    {
      name: "strict-fp/recommended",
      files,
      plugins: {
        "strict-fp": plugin,
      },
      rules: strictFpRules(maxLines),
    },
    ...(options.boundaryFiles && options.boundaryFiles.length > 0
      ? [
          {
            name: "strict-fp/boundary-overrides",
            files: [...options.boundaryFiles],
            rules: {
              "strict-fp/no-throw-outside-unsafe": "off",
              "strict-fp/no-if-else-or-switch": "off",
              "strict-fp/no-imperative-loops": "off",
              "strict-fp/no-let-or-var": "off",
              "strict-fp/max-function-lines": "off",
              "strict-fp/no-unnecessary-local-const": "off",
              "strict-fp/prefer-fp-ts-array-methods": "off",
              "strict-fp/no-null-undefined": "off",
              "strict-fp/no-domain-raw-primitives": "off",
              "strict-fp/require-exhaustive-match": "off",
              "strict-fp/no-any-or-unknown": "off",
              "@typescript-eslint/no-deprecated": "off",
            } satisfies TSESLint.FlatConfig.Rules,
          },
        ]
      : []),
    ...(options.testFiles && options.testFiles.length > 0
      ? [
          {
            name: "strict-fp/test-overrides",
            files: [...options.testFiles],
            rules: {
              "strict-fp/max-function-lines": "off",
              "strict-fp/no-domain-raw-primitives": "off",
              "strict-fp/no-null-undefined": "off",
              "strict-fp/no-throw-outside-unsafe": "off",
              "strict-fp/no-let-or-var": "off",
            } satisfies TSESLint.FlatConfig.Rules,
          },
        ]
      : []),
  ];

  return baseConfigs;
};

export const pluginMeta = {
  name: "@mye-org/eslint-plugin-strict-fp",
  version: "0.1.0",
} as const;

export const pluginRules = rules;
