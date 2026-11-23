import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "preferType" | "preferUnionOverEnum";

const isAmbientModuleAugmentation = (node: TSESTree.TSInterfaceDeclaration) => {
  const parent = node.parent;
  const blockParent =
    parent.type === AST_NODE_TYPES.ExportNamedDeclaration ? parent.parent : parent;
  return blockParent.type === AST_NODE_TYPES.TSModuleBlock && blockParent.parent.declare;
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
      match(isAmbientModuleAugmentation(node))
        .with(true, () => {})
        .with(false, () => {
          context.report({ node, messageId: "preferType" });
        })
        .exhaustive();
    },
    TSEnumDeclaration: (node: TSESTree.TSEnumDeclaration) => {
      context.report({ node, messageId: "preferUnionOverEnum" });
    },
  }),
});
