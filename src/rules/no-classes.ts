import { AST_NODE_TYPES, TSESLint, TSESTree } from "@typescript-eslint/utils";
import { match } from "ts-pattern";
import { createRule } from "../lib/rule-factory.js";

type MessageIds = "noClass";
type ClassNode = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

const isAmbientClassDeclaration = (node: ClassNode) =>
  node.type === AST_NODE_TYPES.ClassDeclaration && node.declare;

const reportNonAmbientClass = (
  node: ClassNode,
  report: (d: TSESLint.ReportDescriptor<MessageIds>) => void,
) => {
  match(isAmbientClassDeclaration(node))
    .with(true, () => {})
    .with(false, () => { report({ node, messageId: "noClass" }); })
    .exhaustive();
};

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
    const check = (node: ClassNode) => {
      reportNonAmbientClass(node, (d) => { context.report(d); });
    };
    return {
      ClassDeclaration: check,
      ClassExpression: check,
    };
  },
});
