import { TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noLetOrVar" | "noMutation";

const checkVariableDeclaration = (
  node: TSESTree.VariableDeclaration,
  report: (d: Readonly<{ node: TSESTree.Node; messageId: MessageIds; data: Readonly<Record<string, string>> }>) => void,
) => {
  match({ declare: node.declare, kind: node.kind })
    .with({ declare: false, kind: "let" }, { declare: false, kind: "var" }, ({ kind }) => {
      report({ node, messageId: "noLetOrVar", data: { kind } });
    })
    .otherwise(() => {});
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
        "Avoid `{{kind}}` bindings. Use `const` and `flow(...)` expressions instead.",
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
