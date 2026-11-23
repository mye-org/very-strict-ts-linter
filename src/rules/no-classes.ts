import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noClass";

export const noClasses = createRule<[], MessageIds>({
  name: "no-classes",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow class declarations and class expressions; use pure functions, types, and immutable data structures instead.",
    },
    messages: {
      noClass:
        "Avoid classes. Use pure functions, immutable data types, and module functions instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const reportClass = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression) => {
      if (node.type === "ClassDeclaration" && node.declare) {
        return;
      }
      context.report({ node, messageId: "noClass" });
    };
    return {
      ClassDeclaration: reportClass,
      ClassExpression: reportClass,
    };
  },
});
