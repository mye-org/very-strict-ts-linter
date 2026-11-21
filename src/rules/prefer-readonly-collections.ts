import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "preferReadonlyArray" | "preferReadonlyMap" | "preferReadonlySet";

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
  },
  defaultOptions: [],
  create: (context) => ({
    TSArrayType: (node: TSESTree.TSArrayType) => {
      context.report({ node, messageId: "preferReadonlyArray" });
    },
    TSTypeReference: (node: TSESTree.TSTypeReference) => {
      if (node.typeName.type !== AST_NODE_TYPES.Identifier) {
        return;
      }
      match(node.typeName.name)
        .with("Array", () => {
          context.report({ node, messageId: "preferReadonlyArray" });
        })
        .with("Map", () => {
          context.report({ node, messageId: "preferReadonlyMap" });
        })
        .with("Set", () => {
          context.report({ node, messageId: "preferReadonlySet" });
        })
        .otherwise(() => undefined);
    },
  }),
});
