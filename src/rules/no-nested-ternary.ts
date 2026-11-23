import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noNestedTernary";

const isNestedTernary = (node: TSESTree.ConditionalExpression) =>
  node.test.type === AST_NODE_TYPES.ConditionalExpression ||
  node.consequent.type === AST_NODE_TYPES.ConditionalExpression ||
  node.alternate.type === AST_NODE_TYPES.ConditionalExpression;

const reportIfNestedTernary = (
  node: TSESTree.ConditionalExpression,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isNestedTernary(node))
    .with(true, () => { report({ node, messageId: "noNestedTernary" }); })
    .with(false, () => {})
    .exhaustive();
};

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
      reportIfNestedTernary(node, (d) => { context.report(d); });
    },
  }),
});
