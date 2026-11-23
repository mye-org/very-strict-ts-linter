import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match, P } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noNestedTernary";

export const noNestedTernary = createRule<[], MessageIds>({
  name: "no-nested-ternary",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow nested ternary expressions; use `match` from `ts-pattern` or `flow(...)` with `O.fold`/`E.match`.",
    },
    messages: {
      noNestedTernary:
        "Avoid nested ternaries. Use `match(...).exhaustive()` or `flow(...)` with `O.fold`/`E.match`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    ConditionalExpression: (node: TSESTree.ConditionalExpression) => {
      match({
        testType: node.test.type,
        consequentType: node.consequent.type,
        alternateType: node.alternate.type,
      })
        .with(
          P.union(
            { testType: AST_NODE_TYPES.ConditionalExpression },
            { consequentType: AST_NODE_TYPES.ConditionalExpression },
            { alternateType: AST_NODE_TYPES.ConditionalExpression },
          ),
          () => {
            context.report({ node, messageId: "noNestedTernary" });
          },
        )
        .otherwise(() => {});
    },
  }),
});
