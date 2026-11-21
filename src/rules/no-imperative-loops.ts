import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils/create-rule.js";

type MessageIds = "noImperativeLoop";

export const noImperativeLoops = createRule<[], MessageIds>({
  name: "no-imperative-loops",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow imperative loops (`for`, `while`, `do-while`, `for..in`, `for..of`); use `RA.map`, `RA.filter`, `RA.reduce` instead.",
    },
    messages: {
      noImperativeLoop:
        "Avoid imperative loops. Use `RA.map`, `RA.filter`, `RA.reduce`, or recursion instead.",
    },
    schema: [],
  },
  defaultOptions: [],
  create: (context) => ({
    ForStatement: (node: TSESTree.ForStatement) => {
      context.report({ node, messageId: "noImperativeLoop" });
    },
    ForInStatement: (node: TSESTree.ForInStatement) => {
      context.report({ node, messageId: "noImperativeLoop" });
    },
    ForOfStatement: (node: TSESTree.ForOfStatement) => {
      context.report({ node, messageId: "noImperativeLoop" });
    },
    WhileStatement: (node: TSESTree.WhileStatement) => {
      context.report({ node, messageId: "noImperativeLoop" });
    },
    DoWhileStatement: (node: TSESTree.DoWhileStatement) => {
      context.report({ node, messageId: "noImperativeLoop" });
    },
  }),
});
