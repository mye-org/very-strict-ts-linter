import { AST_NODE_TYPES, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import { pipe } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { createRule } from "../utils/create-rule.js";
import { isFlowCallExpression, isPipeCallExpression } from "../utils/type-helpers.js";

type MessageIds = "noNestedPipe";

const isPipelineCall = (node: TSESTree.CallExpression) =>
  isPipeCallExpression(node) || isFlowCallExpression(node);

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive AST walk
const hasEnclosingPipelineCall = (node: TSESTree.Node): boolean =>
  pipe(
    O.fromNullable(node.parent),
    O.exists(
      (parent) =>
        (parent.type === AST_NODE_TYPES.CallExpression && isPipelineCall(parent)) ||
        hasEnclosingPipelineCall(parent),
    ),
  );

const checkPipeCall = (
  node: TSESTree.CallExpression,
  report: (n: TSESTree.CallExpression) => void,
) => {
  match(isPipelineCall(node) && hasEnclosingPipelineCall(node))
    .with(true, () => {
      report(node);
    })
    .with(false, () => {})
    .exhaustive();
};

export const noNestedPipe = createRule<[], MessageIds>({
  name: "no-nested-pipe",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow nested `pipe`/`flow` calls; extract inner pipelines into standalone functions per the single responsibility principle.",
    },
    messages: {
      noNestedPipe:
        "Avoid nested `pipe(...)`/`flow(...)` calls. Extract the inner pipeline into a standalone function (single responsibility principle).",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    CallExpression: (node) => {
      checkPipeCall(node, (target) => {
        context.report({ node: target, messageId: "noNestedPipe" });
      });
    },
  }),
});
