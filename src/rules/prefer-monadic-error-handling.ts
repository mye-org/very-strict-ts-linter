import { AST_NODE_TYPES, ESLintUtils, ParserServicesWithTypeInformation, TSESTree } from "@typescript-eslint/utils";
import * as O from "fp-ts/lib/Option.js";
import * as Pred from "fp-ts/lib/Predicate.js";
import { flow } from "fp-ts/lib/function.js";
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

const isPromiseSymbol = (
  object: TSESTree.Expression,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => {
  const symbol = checker
    .getTypeAtLocation(services.esTreeNodeToTSNodeMap.get(object))
    .getSymbol();
  return symbol?.name === "Promise" || symbol?.name === "PromiseLike";
};

const isPromiseTerminalCall = (
  object: TSESTree.Expression,
  propName: string,
  services: ParserServicesWithTypeInformation,
  checker: ts.TypeChecker,
) => PROMISE_TERMINAL_METHODS.has(propName) && isPromiseSymbol(object, services, checker);

const reportPromiseMemberCall = (
  node: TSESTree.CallExpression,
  callee: TSESTree.MemberExpression & { property: TSESTree.Identifier },
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
  match({
    isStatic: isPromiseStaticCall(callee.object, callee.property.name),
    isTerminal: isPromiseTerminalCall(callee.object, callee.property.name, services, services.program.getTypeChecker()),
  })
    .with({ isStatic: true }, () => { report(node, "noRawPromise"); })
    .with({ isTerminal: true }, () => { report(callee.property, "noRawPromise"); })
    .otherwise(() => {});
};

const checkCallExpression = (
  node: TSESTree.CallExpression,
  services: ParserServicesWithTypeInformation,
  report: (n: TSESTree.Node, messageId: MessageIds) => void,
) => {
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
      ({ callee }) => { reportPromiseMemberCall(node, callee, services, report); },
    )
    .otherwise(() => {});
};

const isRawNewPromise = (node: TSESTree.NewExpression) =>
  node.callee.type === AST_NODE_TYPES.Identifier &&
  PROMISE_CONSTRUCTOR_NAMES.has(node.callee.name) &&
  !isInsideUnsafeOrMustFunction(node);

const reportWhen = <N extends TSESTree.Node>(
  node: N,
  predicate: Pred.Predicate<N>,
  onMatch: (n: N) => void,
) => {
  flow(O.fromPredicate(predicate), O.map(onMatch))(node);
};

const buildErrorHandlingListeners = (
  services: ParserServicesWithTypeInformation,
  report: (node: TSESTree.Node, messageId: MessageIds) => void,
) => {
  const checkAsync = (node: TSESTree.FunctionDeclaration | TSESTree.FunctionExpression | TSESTree.ArrowFunctionExpression) => {
    reportWhen(node, (n) => n.async && !isExemptFunction(n), (n) => { report(n, "noAsyncAwait"); });
  };
  return {
    TryStatement: (node: TSESTree.TryStatement) => { reportWhen(node, (n) => !isInsideUnsafeOrMustFunction(n), (n) => { report(n, "noTryCatch"); }); },
    FunctionDeclaration: checkAsync,
    FunctionExpression: checkAsync,
    ArrowFunctionExpression: checkAsync,
    AwaitExpression: (node: TSESTree.AwaitExpression) => { reportWhen(node, (n) => !isInsideAsyncFunction(n) && !isInsideUnsafeOrMustFunction(n), (n) => { report(n, "noAsyncAwait"); }); },
    NewExpression: (node: TSESTree.NewExpression) => { reportWhen(node, isRawNewPromise, (n) => { report(n, "noRawPromise"); }); },
    CallExpression: (node: TSESTree.CallExpression) => { checkCallExpression(node, services, report); },
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
