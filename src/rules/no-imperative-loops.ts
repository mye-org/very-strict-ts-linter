import { TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../lib/rule-factory.js";

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
    defaultOptions: [],
  },
  create: (context) => {
    const reportLoop = (node: TSESTree.Node) => {
      context.report({ node, messageId: "noImperativeLoop" });
    };
    return {
      ForStatement: reportLoop,
      ForInStatement: reportLoop,
      ForOfStatement: reportLoop,
      WhileStatement: reportLoop,
      DoWhileStatement: reportLoop,
    };
  },
});
