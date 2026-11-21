import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noNullType" | "noUndefinedType" | "noNullLiteral" | "noOptionalProperty";

export const noNullUndefined = createRule<[], MessageIds>({
  name: "no-null-undefined",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow null and undefined in types and values; use Option<A> from fp-ts instead.",
    },
    messages: {
      noNullType:
        "Avoid `null` in types. Use `Option<A>` from `fp-ts` instead.",
      noUndefinedType:
        "Avoid `undefined` in types. Use `Option<A>` from `fp-ts` instead.",
      noNullLiteral:
        "Avoid `null` literals. Use `O.none` from `fp-ts/lib/Option` instead.",
      noOptionalProperty:
        "Avoid optional properties (`?:`). Use `Option<A>` from `fp-ts` instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    TSNullKeyword: (node: TSESTree.TSNullKeyword) => {
      context.report({ node, messageId: "noNullType" });
    },
    TSUndefinedKeyword: (node: TSESTree.TSUndefinedKeyword) => {
      context.report({ node, messageId: "noUndefinedType" });
    },
    TSPropertySignature: (node: TSESTree.TSPropertySignature) => {
      if (node.optional) {
        context.report({ node, messageId: "noOptionalProperty" });
      }
    },
    Literal: (node: TSESTree.Literal) => {
      if (node.value === null && node.parent.type !== AST_NODE_TYPES.TSLiteralType) {
        context.report({ node, messageId: "noNullLiteral" });
      }
    },
  }),
});
