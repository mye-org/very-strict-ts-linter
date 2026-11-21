import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "preferReadonlyArray" | "preferReadonlyMap" | "preferReadonlySet";

const TYPE_TO_MESSAGE: Readonly<Record<string, MessageIds>> = {
  Array: "preferReadonlyArray",
  Map: "preferReadonlyMap",
  Set: "preferReadonlySet",
};

const reportTypeReference = (
  node: TSESTree.TSTypeReference,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  if (node.typeName.type !== AST_NODE_TYPES.Identifier) {
    return;
  }
  const messageId = TYPE_TO_MESSAGE[node.typeName.name];
  if (messageId) {
    report(node, messageId);
  }
};

export const preferReadonlyCollections = createRule<[], MessageIds>({
  name: "prefer-readonly-collections",
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce ReadonlyArray, ReadonlyMap, and ReadonlySet over mutable Array, Map, and Set in type annotations.",
    },
    messages: {
      preferReadonlyArray:
        "Use `ReadonlyArray<T>` instead of mutable `Array<T>` or `T[]`.",
      preferReadonlyMap:
        "Use `ReadonlyMap<K, V>` instead of mutable `Map<K, V>`.",
      preferReadonlySet:
        "Use `ReadonlySet<T>` instead of mutable `Set<T>`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TSArrayType: (node) => {
      context.report({ node, messageId: "preferReadonlyArray" });
    },
    TSTypeReference: (node) => {
      reportTypeReference(node, (n, messageId) => {
        context.report({ node: n, messageId });
      });
    },
  }),
});
