import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noLetOrVar" | "noMutation";

export const noLetOrVar = createRule<[], MessageIds>({
  name: "no-let-or-var",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow mutable `let`/`var` bindings, assignments, and `++`/`--` updates.",
    },
    messages: {
      noLetOrVar:
        "Avoid `{{kind}}` bindings. Use `const` and `pipe` expressions instead.",
      noMutation:
        "Avoid mutable assignments or `++`/`--` updates. Return new immutable values instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    VariableDeclaration: (node: TSESTree.VariableDeclaration) => {
      if (node.kind !== "const") {
        context.report({
          node,
          messageId: "noLetOrVar",
          data: { kind: node.kind },
        });
      }
    },
    UpdateExpression: (node: TSESTree.UpdateExpression) => {
      context.report({ node, messageId: "noMutation" });
    },
    AssignmentExpression: (node: TSESTree.AssignmentExpression) => {
      context.report({ node, messageId: "noMutation" });
    },
  }),
});
