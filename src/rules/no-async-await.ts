import { TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { pipe } from "fp-ts/lib/function.js";
import { createRule } from "../utils/create-rule.js";

import {
  getDirectFunctionName,
  isInsideUnsafeOrMustFunction,
  isUnsafeOrMustName,
} from "../utils/type-helpers.js";

type MessageIds = "noAsync" | "noAwait";

type AnyFunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const isExemptAsyncFn = (node: AnyFunctionNode) =>
  isInsideUnsafeOrMustFunction(node) ||
  pipe(getDirectFunctionName(node), O.exists(isUnsafeOrMustName));

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => {
  pipe(O.some(node), O.filter(predicate), O.map(onMatch));
};

const createVisitors = (
  reportAsync: (n: AnyFunctionNode) => void,
  reportAwait: (n: TSESTree.Node) => void,
) => {
  const checkAsyncFn = (node: AnyFunctionNode) => {
    reportWhen(node, (n) => n.async && !isExemptAsyncFn(n), reportAsync);
  };
  const checkAwaitNode = (node: TSESTree.Node) => {
    reportWhen(node, (n) => !isInsideUnsafeOrMustFunction(n), reportAwait);
  };
  return {
    FunctionDeclaration: checkAsyncFn,
    FunctionExpression: checkAsyncFn,
    ArrowFunctionExpression: checkAsyncFn,
    AwaitExpression: checkAwaitNode,
    ForOfStatement: (node: TSESTree.ForOfStatement) => {
      reportWhen(node, (n) => n.await && !isInsideUnsafeOrMustFunction(n), reportAwait);
    },
    VariableDeclaration: (node: TSESTree.VariableDeclaration) => {
      reportWhen(node, (n) => n.kind === "await using" && !isInsideUnsafeOrMustFunction(n), reportAwait);
    },
  };
};

export const noAsyncAwait = createRule<[], MessageIds>({
  name: "no-async-await",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `async` and `await` keywords outside `*Unsafe`/`must*` helpers; use `Task` or `TaskEither` instead.",
    },
    messages: {
      noAsync:
        "Avoid the `async` keyword. Use `Task` or `TaskEither` (`T.*`, `TE.*`) instead.",
      noAwait:
        "Avoid the `await` keyword. Use `Task` or `TaskEither` (`T.*`, `TE.*`) instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) =>
    createVisitors(
      (node) => { context.report({ node, messageId: "noAsync" }); },
      (node) => { context.report({ node, messageId: "noAwait" }); },
    ),
});
