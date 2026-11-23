import { ESLintUtils } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator(
  (name) =>
    `https://github.com/mye-org/very-strict-ts-linter/blob/main/docs/rules/${name}.md`,
);
