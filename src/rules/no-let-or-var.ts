import { TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noLetOrVar" | "noMutation";

const checkVariableDeclaration = (
  node: TSESTree.VariableDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  match(node.kind)
    .with("const", "using", "await using", () => {})
    .with("let", "var", (kind) => {
      report({ node, messageId: "noLetOrVar", data: { kind } });
    })
    .exhaustive();
};

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
    defaultOptions: [],
  },
  create: (context) => {
    const reportMutation = (node: TSESTree.Node) => {
      context.report({ node, messageId: "noMutation" });
    };
    return {
      VariableDeclaration: (node: TSESTree.VariableDeclaration) => {
        checkVariableDeclaration(node, (d) => { context.report(d); });
      },
      UpdateExpression: reportMutation,
      AssignmentExpression: reportMutation,
    };
  },
});
