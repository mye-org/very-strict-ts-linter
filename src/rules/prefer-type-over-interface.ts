import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "preferType" | "preferUnionOverEnum";

export const preferTypeOverInterface = createRule<[], MessageIds>({
  name: "prefer-type-over-interface",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `type` aliases over `interface` and discriminated unions over `enum`.",
    },
    messages: {
      preferType: "Prefer `type` over `interface`.",
      preferUnionOverEnum:
        "Prefer discriminated union types over `enum` declarations.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSInterfaceDeclaration: (node: TSESTree.TSInterfaceDeclaration) => {
      context.report({ node, messageId: "preferType" });
    },
    TSEnumDeclaration: (node: TSESTree.TSEnumDeclaration) => {
      context.report({ node, messageId: "preferUnionOverEnum" });
    },
  }),
});
