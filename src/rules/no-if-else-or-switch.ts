import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noIfElse" | "noSwitch";

const isElseIfBranch = (node: TSESTree.IfStatement) =>
  node.parent.type === AST_NODE_TYPES.IfStatement && node.parent.alternate === node;

export const noIfElseOrSwitch = createRule<[], MessageIds>({
  name: "no-if-else-or-switch",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `if`, `if-else`, and `switch` statements; always prefer `match` from `ts-pattern` instead (for complex conditions, consider introducing a temporary inline object such as `match({ a: x, b: y })`).",
    },
    messages: {
      noIfElse:
        "Avoid `if` and `if-else` statements. Always prefer `match(...).exhaustive()` (or `.otherwise(...)`) from `ts-pattern` instead; for complex conditions, consider introducing a temporary inline object such as `match({ a: x, b: y })`.",
      noSwitch:
        "Avoid `switch` statements. Always prefer `match(...).exhaustive()` (or `.otherwise(...)`) from `ts-pattern` instead; for complex conditions, consider introducing a temporary inline object such as `match({ a: x, b: y })`.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    IfStatement: (node: TSESTree.IfStatement) => {
      match(isElseIfBranch(node))
        .with(false, () => {
          context.report({ node, messageId: "noIfElse" });
        })
        .with(true, () => {})
        .exhaustive();
    },
    SwitchStatement: (node: TSESTree.SwitchStatement) => {
      context.report({ node, messageId: "noSwitch" });
    },
  }),
});
