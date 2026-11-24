import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { match } from "ts-pattern";
import * as ts from "typescript";
import { isEsTreeFunctionNode } from "../lib/estree-function-nodes.js";
import { createRule } from "../lib/rule-factory.js";
import { isInsideUnsafeOrMustFunction, isUnsafeOrMustName, resolveDirectFunctionName } from "../lib/unsafe-function-scope.js";

type MessageIds = "noTryCatch" | "noAsyncAwait" | "noRawPromise";

const PROMISE_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(["Promise"]);
const PROMISE_TERMINAL_METHODS = new Set(["then", "catch", "finally"]);
const PROMISE_STATIC_METHODS = new Set([
  "resolve",
  "reject",
  "all",
  "allSettled",
  "race",
  "any",
]);

const isExemptFunction = (node: TSESTree.Node) =>
  isInsideUnsafeOrMustFunction(node) ||
  O.exists(isUnsafeOrMustName)(resolveDirectFunctionName(node));

const isAsyncFunctionNode = (node: TSESTree.Node) =>
  isEsTreeFunctionNode(node) && node.async;

// eslint-disable-next-line strict-fp/no-explicit-return-type -- required by TS7023 for recursive helper
const isInsideAsyncFunction = (node: TSESTree.Node): boolean =>
  node.parent
    ? isAsyncFunctionNode(node.parent) || isInsideAsyncFunction(node.parent)
    : false;

const isPromiseStaticCall = (object: TSESTree.Expression, propName: string) =>
  object.type === AST_NODE_TYPES.Identifier &&
  PROMISE_CONSTRUCTOR_NAMES.has(object.name) &&
  PROMISE_STATIC_METHODS.has(propName);

const isPromiseSymbol = ({
  object,
  services,
  checker,
}: Readonly<{
  object: TSESTree.Expression;
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) => {
  const symbol = checker
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(object))
    .getSymbol();
  return symbol?.name === "Promise" || symbol?.name === "PromiseLike";
};

const isPromiseTerminalCall = ({
  callee,
  services,
  checker,
}: Readonly<{
  callee: TSESTree.MemberExpression & { property: TSESTree.Identifier };
  services: ParserServicesWithTypeInformation;
  checker: ts.TypeChecker;
}>) =>
  PROMISE_TERMINAL_METHODS.has(callee.property.name) &&
  isPromiseSymbol({ object: callee.object, services, checker });

const reportPromiseMemberCall =
  (
    services: ParserServicesWithTypeInformation,
    report: (n: TSESTree.Node, messageId: MessageIds) => void,
  ) =>
  (
    node: TSESTree.CallExpression,
    callee: TSESTree.MemberExpression & { property: TSESTree.Identifier },
  ) => {
    match({
      isStatic: isPromiseStaticCall(callee.object, callee.property.name),
      isTerminal: isPromiseTerminalCall({
        callee,
        services,
        checker: services.program.getTypeChecker(),
      }),
    })
      .with({ isStatic: true }, () => { report(node, "noRawPromise"); })
      .with({ isTerminal: true }, () => { report(callee.property, "noRawPromise"); })
      .otherwise(() => {});
  };

const checkCallExpression =
  (
    services: ParserServicesWithTypeInformation,
    report: (n: TSESTree.Node, messageId: MessageIds) => void,
  ) =>
  (node: TSESTree.CallExpression) => {
    match({ callee: node.callee, insideUnsafe: isInsideUnsafeOrMustFunction(node) })
      .with(
        {
          insideUnsafe: false,
          callee: {
            type: AST_NODE_TYPES.MemberExpression,
            computed: false,
            property: { type: AST_NODE_TYPES.Identifier },
          },
        },
        ({ callee }) => { reportPromiseMemberCall(services, report)(node, callee); },
      )
      .otherwise(() => {});
  };

const isRawNewPromise = (node: TSESTree.NewExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  PROMISE_CONSTRUCTOR_NAMES.has(node.callee.name) &&
  !isInsideUnsafeOrMustFunction(node);

const reportWhen =
  <N extends TSESTree.Node>(predicate: Pred.Predicate<N>, onMatch: (n: N) => void) =>
  (node: N) => {
    O.map(onMatch)(O.fromPredicate(predicate)(node));
  };

const buildErrorHandlingListeners = (
  services: ParserServicesWithTypeInformation,
  report: (node: TSESTree.Node, messageId: MessageIds) => void,
) => {
  const checkAsync = reportWhen<
    TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression
  >((n) => n.async && !isExemptFunction(n), (n) => { report(n, "noAsyncAwait"); });
  return {
    TryStatement: reportWhen<TSESTree.TryStatement>((n) => !isInsideUnsafeOrMustFunction(n), (n) => { report(n, "noTryCatch"); }),
    FunctionDeclaration: checkAsync,
    FunctionExpression: checkAsync,
    ArrowFunctionExpression: checkAsync,
    AwaitExpression: reportWhen<TSESTree.AwaitExpression>((n) => !isInsideAsyncFunction(n) && !isInsideUnsafeOrMustFunction(n), (n) => { report(n, "noAsyncAwait"); }),
    NewExpression: reportWhen<TSESTree.NewExpression>(isRawNewPromise, (n) => { report(n, "noRawPromise"); }),
    CallExpression: checkCallExpression(services, report),
  };
};

export const preferMonadicErrorHandling = createRule<[], MessageIds>({
  name: "prefer-monadic-error-handling",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Encourage monadic error and async handling (`Either`, `Task`, `TaskEither`) over `try/catch`, `async/await`, and raw `Promise`.",
    },
    messages: {
      noTryCatch: "Avoid `try/catch`. Use `E.tryCatch` or `TE.tryCatch` from `fp-ts` instead.",
      noAsyncAwait: "Avoid `async/await`. Use `Task` or `TaskEither` (`T.*`, `TE.*`) from `fp-ts` instead.",
      noRawPromise: "Avoid raw `Promise` (`.then()`/`.catch()`/`new Promise()`). Use `Task` or `TaskEither` instead.",
    },
    schema: [],
    defaultOptions: [],
  },
  create: (context) => {
    const report = (node: TSESTree.Node, messageId: MessageIds) => {
      context.report({ node, messageId });
    };
    return buildErrorHandlingListeners(ESLintUtils.getParserServices(context), report);
  },
});
