import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noIfElse" | "noSwitch";

export const noIfElseOrSwitch = createRule<[], MessageIds>({
  name: "no-if-else-or-switch",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `switch` statements and `if-else` chains; use `match` from `ts-pattern` instead (single-branch guard `if` is allowed).",
    },
    messages: {
      noIfElse:
        "Avoid `if-else` chains. Use `match(...).exhaustive()` from `ts-pattern` instead.",
      noSwitch:
        "Avoid `switch` statements. Use `match(...).exhaustive()` from `ts-pattern` instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    IfStatement: (node: TSESTree.IfStatement) => {
      if (node.alternate !== null) {
        context.report({ node: node.alternate, messageId: "noIfElse" });
      }
    },
    SwitchStatement: (node: TSESTree.SwitchStatement) => {
      context.report({ node, messageId: "noSwitch" });
    },
  }),
});
