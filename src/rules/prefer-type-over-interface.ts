import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "preferType" | "preferUnionOverEnum";

const isAmbientModuleAugmentation = (node: TSESTree.TSInterfaceDeclaration) => {
  const parent = node.parent;
  const blockParent =
    parent.type === AST_NODE_TYPES.ExportNamedDeclaration ? parent.parent : parent;
  return (
    blockParent.type === AST_NODE_TYPES.TSModuleBlock &&
    blockParent.parent.type === AST_NODE_TYPES.TSModuleDeclaration &&
    blockParent.parent.declare
  );
};

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
      if (!isAmbientModuleAugmentation(node)) {
        context.report({ node, messageId: "preferType" });
      }
    },
    TSEnumDeclaration: (node: TSESTree.TSEnumDeclaration) => {
      context.report({ node, messageId: "preferUnionOverEnum" });
    },
  }),
});
