import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noNestedTernary";

export const noNestedTernary = createRule<[], MessageIds>({
  name: "no-nested-ternary",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow nested ternary expressions; use `match` from `ts-pattern` or `pipe` with `O.fold`/`E.match`.",
    },
    messages: {
      noNestedTernary:
        "Avoid nested ternaries. Use `match(...).exhaustive()` or `pipe` with `O.fold`/`E.match`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ConditionalExpression: (node: TSESTree.ConditionalExpression) => {
      if (
        node.consequent.type === AST_NODE_TYPES.ConditionalExpression ||
        node.alternate.type === AST_NODE_TYPES.ConditionalExpression
      ) {
        context.report({ node, messageId: "noNestedTernary" });
      }
    },
  }),
});
