import { TSESTree } from "@typescript-eslint/utils";
import * as IO from "fp-ts/lib/IO.js";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
import { match } from "ts-pattern";
import { resolveEnclosingEsTreeFunction } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import {
  hasMatchingEnclosingFunctionName,
  isInsideUnsafeOrMustFunction,
} from "../lib/unsafe-function-scope.js";

type MessageIds = "preferIoEitherOverTryCatch";

const UNSAFE_NAME_RE = /unsafe/i;

const noopIo: IO.IO<void> = () => {};

const isInsideUnsafeScope = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  hasMatchingEnclosingFunctionName(node, (name) => UNSAFE_NAME_RE.test(name));

const isAsyncFn = (
  fn:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression,
) => fn.async;

const isDirectlyInsideAsyncFunction = flow(
  resolveEnclosingEsTreeFunction,
  O.exists(isAsyncFn),
);

const shouldReportTryStatement = Pred.not(
  Pred.or(isDirectlyInsideAsyncFunction)(isInsideUnsafeScope),
);

export const preferIoEitherOverTryCatch = createRule<[], MessageIds>({
  name: "prefer-io-either-over-try-catch",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer `IOE.tryCatch` or `E.tryCatch` over `try/catch` statements in non-async functions.",
    },
    messages: {
      preferIoEitherOverTryCatch:
        "Avoid `try/catch` in synchronous functions. Use `IOE.tryCatch` or `E.tryCatch` from `fp-ts` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => ({
    TryStatement: (node: TSESTree.TryStatement) => {
      match(shouldReportTryStatement(node))
        .with(true, () => () => {
          context.report({ node, messageId: "preferIoEitherOverTryCatch" });
        })
        .with(false, () => noopIo)
        .exhaustive()();
    },
  }),
});
