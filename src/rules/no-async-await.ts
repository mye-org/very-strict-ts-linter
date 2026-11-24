import { TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { createRule } from "../lib/rule-factory.js";
import { isInsideUnsafeOrMustFunction, isUnsafeOrMustName, resolveDirectFunctionName } from "../lib/unsafe-function-scope.js";


type MessageIds = "noAsync" | "noAwait";

type AnyFunctionNode =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

const isExemptAsyncFn = (node: AnyFunctionNode) =>
  isInsideUnsafeOrMustFunction(node) ||
  O.exists(isUnsafeOrMustName)(resolveDirectFunctionName(node));

const reportWhen = <N extends TSESTree.Node>(
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => (node: N) => {
  O.map(onMatch)(O.fromPredicate(predicate)(node));
};

const makeAsyncFnChecker =
  (reportAsync: (n: AnyFunctionNode) => void) =>
    reportWhen((n: AnyFunctionNode) => n.async && !isExemptAsyncFn(n), reportAsync);

const makeAwaitChecker =
  (reportAwait: (n: TSESTree.Node) => void) =>
    reportWhen((n: TSESTree.Node) => !isInsideUnsafeOrMustFunction(n), reportAwait);

const buildVisitors = (
  reportAsync: (n: AnyFunctionNode) => void,
  reportAwait: (n: TSESTree.Node) => void,
) => {
  const checkAsyncFn = makeAsyncFnChecker(reportAsync);
  return {
    FunctionDeclaration: checkAsyncFn,
    FunctionExpression: checkAsyncFn,
    ArrowFunctionExpression: checkAsyncFn,
    AwaitExpression: makeAwaitChecker(reportAwait),
    ForOfStatement: reportWhen(
      (n: TSESTree.ForOfStatement) => n.await && !isInsideUnsafeOrMustFunction(n),
      reportAwait,
    ),
    VariableDeclaration: reportWhen(
      (n: TSESTree.VariableDeclaration) => n.kind === "await using" && !isInsideUnsafeOrMustFunction(n),
      reportAwait,
    ),
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
    buildVisitors(
      (node) => { context.report({ node, messageId: "noAsync" }); },
      (node) => { context.report({ node, messageId: "noAwait" }); },
    ),
});
